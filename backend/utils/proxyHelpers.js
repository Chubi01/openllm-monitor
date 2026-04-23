/**
 * Shared proxy helper functions used by both server.js (transparent proxy)
 * and routes/proxy.js (API proxy routes).
 */

const Log = require("../models/Log");
const tokenCounter = require("./tokenCounter");
const costEstimator = require("./costEstimator");
const wsEmitter = require("./wsEmitter");

// ── Content extraction ───────────────────────────────────────────────

/**
 * Extract text from Anthropic content blocks (string or array of {type, text} objects)
 */
function extractContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n");
  }
  return String(content);
}

/**
 * Strip system context tags from prompt content to show only the
 * actual user message in the dashboard.
 */
function stripSystemContext(text) {
  if (!text || typeof text !== "string") return text || "";
  let cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  cleaned = cleaned.replace(/<claudeMd>[\s\S]*?<\/claudeMd>/gi, "");
  cleaned = cleaned.trim();
  return cleaned || text;
}

function extractPrompt(body) {
  if (body.messages && Array.isArray(body.messages)) {
    // Use the LAST user message (the current prompt), not the first
    const userMsg = body.messages.findLast((m) => m.role === "user");
    const content = extractContent(userMsg?.content);
    return stripSystemContext(content);
  }
  return body.prompt ? stripSystemContext(extractContent(body.prompt)) : "";
}

function extractSystemMessage(body) {
  if (body.messages && Array.isArray(body.messages)) {
    const sysMsg = body.messages.find((m) => m.role === "system");
    return extractContent(sysMsg?.content) || "";
  }
  return extractContent(body.system) || "";
}

function extractCompletion(data) {
  if (!data) return "";
  // Ollama /api/chat format
  if (data.message?.content) return extractContent(data.message.content);
  // glm models put response in message.thinking
  if (data.message?.thinking && !data.message?.content) return extractContent(data.message.thinking);
  // Ollama /api/generate format
  if (data.response) return data.response;
  // Anthropic Messages API format
  if (data.content && Array.isArray(data.content)) {
    const textBlocks = data.content.filter((b) => b.type === "text");
    if (textBlocks.length > 0) return textBlocks.map((b) => b.text).join("\n");
    const thinkingBlocks = data.content.filter((b) => b.type === "thinking");
    if (thinkingBlocks.length > 0) return thinkingBlocks.map((b) => b.thinking || b.text || "").join("\n");
  }
  // OpenAI Chat Completions format
  if (data.choices?.[0]?.message?.content) return extractContent(data.choices[0].message.content);
  if (data.choices?.[0]?.text) return data.choices[0].text;
  // Handle streaming: multiple chunks concatenated
  if (Array.isArray(data)) {
    return data
      .filter((chunk) => chunk.message?.content)
      .map((chunk) => chunk.message.content)
      .join("");
  }
  return "";
}

// ── Model mapping ────────────────────────────────────────────────────

const MODEL_MAP = {
  "claude-3-5-sonnet-20241022": "glm-5.1:cloud",
  "claude-3-5-haiku-20241022": "kimi-k2.5:cloud",
  "claude-3-opus-20240229": "glm-5.1:cloud",
  "claude-haiku-4-5-20251001": "kimi-k2.5:cloud",
  "claude-sonnet-4-6-20250514": "glm-5.1:cloud",
  "claude-opus-4-7-20250610": "glm-5.1:cloud",
};

// ── Stream parsing ───────────────────────────────────────────────────

/**
 * Parse a single line from a streaming response.
 * Handles both NDJSON (Ollama native) and SSE (Anthropic/OpenAI) formats.
 *
 * NDJSON:  {"message":{"content":"Hello"}}
 * SSE:     data: {"type":"content_block_delta","delta":{"text":"Hello"}}
 *          event: content_block_delta
 */
function parseStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // SSE format: strip "data: " prefix (may include optional space)
  if (trimmed.startsWith("data: ")) {
    const jsonStr = trimmed.slice(6).trim();
    if (jsonStr === "[DONE]") return null;
    try { return JSON.parse(jsonStr); } catch { return null; }
  }
  if (trimmed.startsWith("data:")) {
    const jsonStr = trimmed.slice(5).trim();
    if (jsonStr === "[DONE]") return null;
    try { return JSON.parse(jsonStr); } catch { return null; }
  }
  // Skip SSE event type lines
  if (trimmed.startsWith("event:") || trimmed.startsWith("event: ")) return null;
  // NDJSON: parse directly
  try { return JSON.parse(trimmed); } catch { return null; }
}

/**
 * Extract content from a parsed streaming chunk across all supported formats.
 */
function collectStreamContent(parsed, collected) {
  // Ollama /api/chat
  if (parsed.message?.content) collected.content += parsed.message.content;
  // glm thinking format
  if (parsed.message?.thinking) collected.content += parsed.message.thinking;
  // Ollama /api/generate
  if (parsed.response) collected.content += parsed.response;
  // Anthropic streaming: content_block_delta
  if (parsed.type === "content_block_delta" && parsed.delta?.text) {
    collected.content += parsed.delta.text;
  }
  // Anthropic streaming: message_delta with stop_reason
  if (parsed.type === "message_delta" && parsed.delta?.stop_reason) {
    collected.stopReason = parsed.delta.stop_reason;
  }
  // OpenAI streaming
  if (parsed.choices?.[0]?.delta?.content) collected.content += parsed.choices[0].delta.content;
  // OpenAI finish_reason
  if (parsed.choices?.[0]?.finish_reason) collected.stopReason = parsed.choices[0].finish_reason;
  // Anthropic usage
  if (parsed.usage) {
    collected.usage = { ...collected.usage, ...parsed.usage };
  }
  // OpenAI usage
  if (parsed.usage?.prompt_tokens) collected.inputTokens = parsed.usage.prompt_tokens;
  if (parsed.usage?.completion_tokens) collected.outputTokens = parsed.usage.completion_tokens;
  // Ollama done
  if (parsed.done) collected.doneChunk = parsed;
}

/**
 * Create an empty collected content object for stream accumulation.
 */
function createStreamCollector() {
  return { content: "", doneChunk: null, stopReason: null, usage: null, inputTokens: null, outputTokens: null };
}

// ── Logging ──────────────────────────────────────────────────────────

/**
 * Check if a request should be logged (generate/chat/v1 endpoints)
 */
function isLoggable(path) {
  return (
    path.includes("/api/generate") ||
    path.includes("/api/chat") ||
    path.includes("/v1/messages") ||
    path.includes("/v1/chat/completions")
  );
}

/**
 * Normalise stream flag: accept true, "true", and 1
 */
function isStreamRequest(body) {
  return body.stream === true || body.stream === "true" || body.stream === 1;
}

/**
 * Determine provider from model name and URL path
 */
function determineProvider(model, isV1Endpoint) {
  if (isV1Endpoint && model.endsWith(":cloud")) return "ollama-cloud";
  if (model.endsWith(":cloud")) return "ollama-cloud";
  if (isV1Endpoint) return "ollama";
  if (model.startsWith("claude") || model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) return "ollama";
  return "ollama";
}

/**
 * Build proxy headers for the upstream request
 */
function buildProxyHeaders(reqBody, originalAuth, cloudApiKey) {
  const headers = {
    "Content-Type": "application/json",
  };
  if (reqBody.model?.endsWith(":cloud") && cloudApiKey) {
    headers["Authorization"] = `Bearer ${cloudApiKey}`;
  } else if (originalAuth) {
    headers["Authorization"] = originalAuth;
  }
  return headers;
}

/**
 * Translate Anthropic/OpenAI model names to Ollama model names
 */
function translateModel(model) {
  return MODEL_MAP[model] || model;
}

/**
 * Log a successful proxied request to the database and emit via WebSocket.
 * `requestBody.originalModel` holds the user-facing model name (e.g. "claude-sonnet-4-6-20250514").
 * `requestBody.model` holds the translated Ollama name (e.g. "glm-5.1:cloud").
 */
async function logOllamaCall({ requestId, requestBody, response, latency, provider, isV1Endpoint, collected }) {
  try {
    let responseData;
    if (response.data && typeof response.data === "object" && !Buffer.isBuffer(response.data)) {
      responseData = response.data;
    } else {
      try {
        responseData = JSON.parse(Buffer.from(response.data).toString());
      } catch {
        responseData = {};
      }
    }

    const prompt = extractPrompt(requestBody);
    // Prefer content from the stream collector (handles SSE and NDJSON), fall back to response data
    const completion = collected?.content || responseData._collectedCompletion || extractCompletion(responseData);
    const systemMessage = extractSystemMessage(requestBody);
    // Use original model name for display (e.g. "claude-sonnet-4-6-20250514"),
    // fall back to translated name if original wasn't preserved
    const model = requestBody.originalModel || requestBody.model || "unknown";

    const promptTokens =
      collected?.inputTokens ||
      responseData.prompt_eval_count ||
      responseData.usage?.input_tokens ||
      (await tokenCounter.estimateOllamaTokens(prompt + " " + systemMessage));
    const completionTokens =
      collected?.outputTokens ||
      responseData.eval_count ||
      responseData.usage?.output_tokens ||
      (await tokenCounter.estimateOllamaTokens(completion));

    const finishReason =
      collected?.stopReason ||
      responseData.done_reason ||
      (responseData.done ? "stop" : null) ||
      responseData.stop_reason ||
      responseData.choices?.[0]?.finish_reason ||
      null;

    const cost =
      provider === "ollama"
        ? { promptCost: 0, completionCost: 0, totalCost: 0, currency: "USD" }
        : costEstimator.calculateCost(provider, model, {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          });

    const logEntry = new Log({
      requestId,
      provider,
      model,
      prompt: prompt.substring(0, 10000),
      completion: completion.substring(0, 10000),
      systemMessage: systemMessage.substring(0, 5000),
      parameters: {
        temperature: requestBody.options?.temperature ?? requestBody.temperature,
        maxTokens: requestBody.options?.num_predict ?? requestBody.max_tokens ?? requestBody.maxTokens,
        topP: requestBody.options?.top_p ?? requestBody.top_p ?? requestBody.topP,
      },
      tokenUsage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      cost,
      latency,
      status: "success",
      isStreaming: !!requestBody.stream,
      finishReason,
      createdAt: new Date(),
    });

    await logEntry.save();
    wsEmitter.emitNewLog(logEntry);
  } catch (err) {
    console.error("Failed to log proxied request:", err.message);
  }
}

/**
 * Log a failed proxied request
 */
async function logOllamaError({ requestId, requestBody, error, latency, provider }) {
  try {
    const logEntry = new Log({
      requestId,
      provider,
      model: requestBody.model || "unknown",
      prompt: extractPrompt(requestBody).substring(0, 10000),
      completion: "",
      systemMessage: extractSystemMessage(requestBody).substring(0, 5000),
      parameters: {},
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      cost: { promptCost: 0, completionCost: 0, totalCost: 0, currency: "USD" },
      latency,
      status: "error",
      error: {
        message: error.message,
        code: error.code || error.response?.status?.toString() || "PROXY_ERROR",
      },
      createdAt: new Date(),
    });

    await logEntry.save();
    wsEmitter.emitNewLog(logEntry);
  } catch (err) {
    console.error("Failed to log proxied error:", err.message);
  }
}

module.exports = {
  extractContent,
  stripSystemContext,
  extractPrompt,
  extractSystemMessage,
  extractCompletion,
  parseStreamLine,
  collectStreamContent,
  createStreamCollector,
  MODEL_MAP,
  isLoggable,
  isStreamRequest,
  determineProvider,
  buildProxyHeaders,
  translateModel,
  logOllamaCall,
  logOllamaError,
};