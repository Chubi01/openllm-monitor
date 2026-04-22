const express = require("express");
const router = express.Router();
const axios = require("axios");
const config = require("../config/env");
const Log = require("../models/Log");
const tokenCounter = require("../utils/tokenCounter");
const costEstimator = require("../utils/costEstimator");
const { v4: uuidv4 } = require("uuid");

/**
 * Proxy routes for Ollama Local and Ollama Cloud
 *
 * These routes forward requests to Ollama and log them
 * so that ALL LLM calls appear in the dashboard, not just
 * those made through the /api/providers/:provider/complete endpoint.
 */

// ── Ollama Local Proxy ──────────────────────────────────────────────

// Catch-all: forward any request path to the local Ollama server
router.all("/ollama/*", async (req, res) => {
  const ollamaBase = config.providers.ollama.baseUrl;
  const targetPath = req.params[0] ? `/${req.params[0]}` : "/api/tags";
  const targetUrl = `${ollamaBase}${targetPath}`;

  const requestId = uuidv4();
  const startTime = Date.now();

  // Capture request body for logging
  const requestBody = req.body || {};
  const isGenerate = targetPath.includes("/api/generate");
  const isChat = targetPath.includes("/api/chat");
  const isStreamRequest = requestBody.stream === true;

  try {
    if (isStreamRequest && (isGenerate || isChat)) {
      // Handle streaming: proxy the stream to the client and collect chunks for logging
      const response = await axios({
        method: req.method,
        url: targetUrl,
        data: req.body,
        params: req.query,
        headers: { "Content-Type": "application/json" },
        timeout: 300000,
        responseType: "stream",
      });

      // Forward headers
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Transfer-Encoding", "chunked");

      let collectedContent = "";
      let lastChunk = null;

      response.data.on("data", (chunk) => {
        res.write(chunk);
        // Try to parse each line as JSON and collect the content
        const lines = chunk.toString().split("\n").filter((l) => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.message?.content) {
              collectedContent += parsed.message.content;
            }
            // glm models put response in message.thinking
            if (parsed.message?.thinking && !parsed.message?.content) {
              collectedContent += parsed.message.thinking;
            }
            if (parsed.response) {
              collectedContent += parsed.response;
            }
            if (parsed.done) {
              lastChunk = parsed;
            }
          } catch {
            // Non-JSON line, skip
          }
        }
      });

      response.data.on("end", () => {
        res.end();
        const latency = Date.now() - startTime;

        // Log the completed stream
        if (isGenerate || isChat) {
          const finalData = lastChunk || {};
          finalData.completion = collectedContent;
          logOllamaRequest({
            requestId,
            requestBody,
            responseData: finalData,
            latency,
            provider: "ollama",
          }).catch((err) => console.error("Proxy log error:", err.message));
        }
      });

      response.data.on("error", (streamErr) => {
        console.error("Stream error:", streamErr.message);
        res.end();
      });
    } else {
      // Non-streaming request
      const response = await axios({
        method: req.method,
        url: targetUrl,
        data: req.body,
        params: req.query,
        headers: { "Content-Type": "application/json" },
        timeout: 300000,
      });

      const latency = Date.now() - startTime;

      // Log the request asynchronously
      if (isGenerate || isChat) {
        logOllamaRequest({
          requestId,
          requestBody,
          responseData: response.data,
          latency,
          provider: "ollama",
        }).catch((err) => console.error("Proxy log error:", err.message));
      }

      res.status(response.status).json(response.data);
    }
  } catch (error) {
    const latency = Date.now() - startTime;

    // Log failed requests
    if (isGenerate || isChat) {
      logOllamaError({
        requestId,
        requestBody,
        error,
        latency,
        provider: "ollama",
      }).catch((err) => console.error("Proxy log error:", err.message));
    }

    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(502).json({
        success: false,
        error: "Ollama server unreachable",
        details: error.message,
      });
    }
  }
});

// ── Ollama Cloud Proxy ───────────────────────────────────────────────

router.all("/ollama-cloud/*", async (req, res) => {
  const cloudBase = config.providers.ollamaCloud.baseUrl;
  const cloudKey = config.providers.ollamaCloud.apiKey;
  const targetPath = req.params[0] ? `/${req.params[0]}` : "/api/tags";
  const targetUrl = `${cloudBase}${targetPath}`;

  const requestId = uuidv4();
  const startTime = Date.now();
  const requestBody = req.body || {};
  const isChat = targetPath.includes("/api/chat");
  const isStreamRequest = requestBody.stream === true;

  const headers = { "Content-Type": "application/json" };
  if (cloudKey) {
    headers["Authorization"] = `Bearer ${cloudKey}`;
  }

  try {
    if (isStreamRequest && isChat) {
      // Handle streaming: proxy the stream to the client and collect chunks for logging
      const response = await axios({
        method: req.method,
        url: targetUrl,
        data: req.body,
        params: req.query,
        headers,
        timeout: 300000,
        responseType: "stream",
      });

      // Forward headers
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Transfer-Encoding", "chunked");

      let collectedContent = "";
      let lastChunk = null;

      response.data.on("data", (chunk) => {
        res.write(chunk);
        const lines = chunk.toString().split("\n").filter((l) => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.message?.content) {
              collectedContent += parsed.message.content;
            }
            // glm models put response in message.thinking
            if (parsed.message?.thinking && !parsed.message?.content) {
              collectedContent += parsed.message.thinking;
            }
            if (parsed.response) {
              collectedContent += parsed.response;
            }
            if (parsed.done) {
              lastChunk = parsed;
            }
          } catch {
            // Non-JSON line, skip
          }
        }
      });

      response.data.on("end", () => {
        res.end();
        const latency = Date.now() - startTime;

        if (isChat) {
          const finalData = lastChunk || {};
          finalData.completion = collectedContent;
          logOllamaRequest({
            requestId,
            requestBody,
            responseData: finalData,
            latency,
            provider: "ollama-cloud",
          }).catch((err) => console.error("Proxy log error:", err.message));
        }
      });

      response.data.on("error", (streamErr) => {
        console.error("Cloud stream error:", streamErr.message);
        res.end();
      });
    } else {
      // Non-streaming request
      const response = await axios({
        method: req.method,
        url: targetUrl,
        data: req.body,
        params: req.query,
        headers,
        timeout: 300000,
      });

      const latency = Date.now() - startTime;

      if (isChat) {
        logOllamaRequest({
          requestId,
          requestBody,
          responseData: response.data,
          latency,
          provider: "ollama-cloud",
        }).catch((err) => console.error("Proxy log error:", err.message));
      }

      res.status(response.status).json(response.data);
    }
  } catch (error) {
    const latency = Date.now() - startTime;

    if (isChat) {
      logOllamaError({
        requestId,
        requestBody,
        error,
        latency,
        provider: "ollama-cloud",
      }).catch((err) => console.error("Proxy log error:", err.message));
    }

    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(502).json({
        success: false,
        error: "Ollama Cloud server unreachable",
        details: error.message,
      });
    }
  }
});

// ── Logging helpers ──────────────────────────────────────────────────

async function logOllamaRequest({ requestId, requestBody, responseData, latency, provider }) {
  try {
    const prompt = extractPrompt(requestBody);
    // For streaming responses, use the collected completion content;
    // for non-streaming, extract from response data
    const completion = responseData?.completion || extractCompletion(responseData);
    const systemMessage = extractSystemMessage(requestBody);
    const model = requestBody.model || "unknown";

    const promptTokens = await tokenCounter.estimateOllamaTokens(prompt + " " + systemMessage);
    const completionTokens = await tokenCounter.estimateOllamaTokens(completion);

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
        maxTokens: requestBody.options?.num_predict ?? requestBody.maxTokens,
        topP: requestBody.options?.top_p ?? requestBody.topP,
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
      finishReason: responseData?.done_reason || (responseData?.done ? "stop" : null),
      createdAt: new Date(),
    });

    await logEntry.save();
  } catch (err) {
    console.error("Failed to log proxied request:", err.message);
  }
}

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
  } catch (err) {
    console.error("Failed to log proxied error:", err.message);
  }
}

function extractPrompt(body) {
  if (body.messages && Array.isArray(body.messages)) {
    const userMsg = body.messages.find((m) => m.role === "user");
    const content = userMsg?.content || "";
    if (typeof content === "string") {
      return stripSystemContext(content);
    }
    return String(content);
  }
  return body.prompt ? stripSystemContext(body.prompt) : "";
}

/**
 * Strip system context tags (e.g. <system-reminder>, <claudeMd>) from prompt content
 * to show only the actual user message in the dashboard.
 */
function stripSystemContext(text) {
  if (!text || typeof text !== "string") return text;
  // Remove content between <system-reminder> and </system-reminder> tags
  let cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  // Remove content between <claudeMd> and </claudeMd> tags
  cleaned = cleaned.replace(/<claudeMd>[\s\S]*?<\/claudeMd>/gi, "");
  // Remove leading/trailing whitespace and newlines
  cleaned = cleaned.trim();
  return cleaned || text;
}

function extractSystemMessage(body) {
  if (body.messages && Array.isArray(body.messages)) {
    const sysMsg = body.messages.find((m) => m.role === "system");
    return sysMsg?.content || "";
  }
  return body.system || "";
}

function extractCompletion(data) {
  if (!data) return "";
  if (data.message?.content) return data.message.content;
  // glm models put response in message.thinking
  if (data.message?.thinking && !data.message?.content) return data.message.thinking;
  if (data.response) return data.response;
  if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
  // Handle streaming: multiple chunks may be concatenated
  if (Array.isArray(data)) {
    return data
      .filter((chunk) => chunk.message?.content)
      .map((chunk) => chunk.message.content)
      .join("");
  }
  return "";
}

module.exports = router;