const App = require("./app");
const config = require("./config/env");
const database = require("./config/db");
const express = require("express");
const axios = require("axios");
const Log = require("./models/Log");
const tokenCounter = require("./utils/tokenCounter");
const costEstimator = require("./utils/costEstimator");
const { v4: uuidv4 } = require("uuid");

const OLLAMA_PROXY_PORT = parseInt(process.env.OLLAMA_PROXY_PORT) || 11434;
const OLLAMA_TARGET = process.env.OLLAMA_TARGET_URL || "http://host.docker.internal:11434";

/**
 * OpenLLM Monitor Server
 */
class Server {
  constructor() {
    this.app = new App();
    this.port = config.port;
  }

  async start() {
    try {
      console.log("🔌 Connecting to database...");
      await database.connect();

      // Start main API server
      this.server = this.app.getServer();

      this.server.listen(this.port, () => {
        console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                           OpenLLM Monitor Server                             ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  🚀 Server running on port ${this.port.toString().padEnd(52)}                ║
║  🔀 Ollama proxy on port ${OLLAMA_PROXY_PORT.toString().padEnd(48)}             ║
║  🌐 Environment: ${config.nodeEnv.toUpperCase().padEnd(59)}                  ║
║  📊 Database: ${database.getConnectionStatus().padEnd(62)}                   ║
║  🔗 API Base URL: http://localhost:${this.port}/api${" ".repeat(37)}         ║
║  📡 WebSocket: http://localhost:${this.port}${" ".repeat(42)}                ║
╚══════════════════════════════════════════════════════════════════════════════╝

🎯 Ready to monitor LLM requests!

Ollama Transparent Proxy:
  • Point apps to http://localhost:${OLLAMA_PROXY_PORT} (same as before)
  • Requests are forwarded to ${OLLAMA_TARGET}
  • All calls are automatically logged to the dashboard
  • Zero-config: existing apps work without changes

Supported Providers:
  • Ollama Local (transparent proxy on :${OLLAMA_PROXY_PORT})
  • Ollama Cloud
  • OpenAI (GPT-3.5, GPT-4)
  • OpenRouter (Multi-model access)
  • Mistral AI (Mistral models)
  • Gemini (Google)
  • Grok (xAI)

Environment Configuration:
  • Node.js: ${process.version}
  • MongoDB: ${database.mongoUri}
  • CORS Origins: ${config.corsOrigins.join(", ")}
  • Rate Limiting: ${config.rateLimit.maxRequests} requests per ${
          config.rateLimit.windowMs / 1000 / 60
        } minutes

🔧 To configure providers, visit: http://localhost:${this.port}/api/providers
📖 For API documentation, visit: http://localhost:${this.port}/api/info
        `);

        this.displayProviderStatus();
      });

      this.server.on("error", (error) => {
        if (error.code === "EADDRINUSE") {
          console.error(`❌ Port ${this.port} is already in use`);
          process.exit(1);
        } else {
          console.error("❌ Server error:", error);
        }
      });

      // Start Ollama transparent proxy on port 11434
      this.startOllamaProxy();
    } catch (error) {
      console.error("❌ Failed to start server:", error);
      process.exit(1);
    }
  }

  /**
   * Start transparent Ollama proxy on OLLAMA_PROXY_PORT
   * All requests are forwarded to the real Ollama server and logged
   */
  startOllamaProxy() {
    const proxyApp = express();
    proxyApp.use(express.json({ limit: "50mb" }));
    proxyApp.use(express.raw({ type: "application/octet-stream", limit: "50mb" }));
    proxyApp.use(express.text({ type: "text/plain", limit: "50mb" }));

    // Allow all origins (Ollama is permissive too)
    proxyApp.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      if (req.method === "OPTIONS") return res.sendStatus(200);
      next();
    });

    // Model mapping: Anthropic/OpenAI model names → Ollama model names
    const MODEL_MAP = {
      "claude-3-5-sonnet-20241022": "glm-5.1:cloud",
      "claude-3-5-haiku-20241022": "glm-4.7-flash:latest",
      "claude-3-opus-20240229": "glm-5.1:cloud",
      "claude-haiku-4-5-20251001": "glm-4.7-flash:latest",
      "claude-sonnet-4-6-20250514": "glm-5.1:cloud",
      "claude-opus-4-7-20250610": "glm-5.1:cloud",
    };

    // Catch-all: proxy every request to Ollama
    proxyApp.all("*", async (req, res) => {
      const targetUrl = `${OLLAMA_TARGET}${req.originalUrl}`;
      const isLoggable = req.originalUrl.includes("/api/generate") ||
        req.originalUrl.includes("/api/chat") ||
        req.originalUrl.includes("/v1/messages") ||
        req.originalUrl.includes("/v1/chat/completions");
      const requestId = uuidv4();
      const startTime = Date.now();

      // Determine provider based on URL path and model
      const isV1Endpoint = req.originalUrl.includes("/v1/messages") || req.originalUrl.includes("/v1/chat/completions");
      const isCloudModel = (reqBody) => {
        const model = reqBody?.model || "";
        return model.endsWith(":cloud") || model.includes("cloud") || MODEL_MAP[model];
      };

      // Capture body for logging
      let requestBody = {};
      if (req.is("application/json")) {
        requestBody = req.body || {};
      } else if (req.is("application/octet-stream") || req.is("text/plain")) {
        try { requestBody = JSON.parse(req.body.toString()); } catch (e) { requestBody = {}; }
      }

      // Translate Anthropic/OpenAI model names to Ollama model names
      let proxyBody = { ...requestBody };
      const originalModel = proxyBody.model;
      if (MODEL_MAP[proxyBody.model]) {
        proxyBody.model = MODEL_MAP[proxyBody.model];
      }

      // For logging: use the translated model name
      const logBody = { ...requestBody, model: proxyBody.model };

      // Build proxy headers: use Ollama Cloud API key for cloud models
      const proxyHeaders = {
        "Content-Type": req.get("Content-Type") || "application/json",
      };
      if (proxyBody.model.endsWith(":cloud") && config.providers.ollamaCloud.apiKey) {
        proxyHeaders["Authorization"] = `Bearer ${config.providers.ollamaCloud.apiKey}`;
      } else if (req.get("Authorization")) {
        proxyHeaders["Authorization"] = req.get("Authorization");
      }

      const isStreamRequest = proxyBody.stream === true || proxyBody.stream === "true" || proxyBody.stream === 1;

      try {
        if (isStreamRequest && isLoggable) {
          // Streaming: proxy chunks to client in real-time and collect for logging
          const response = await axios({
            method: req.method,
            url: targetUrl,
            data: proxyBody,
            params: req.query,
            headers: proxyHeaders,
            timeout: 300000,
            responseType: "stream",
          });

          const contentType = response.headers["content-type"] || "application/x-ndjson";
          res.setHeader("Content-Type", contentType);
          if (response.headers["transfer-encoding"]) {
            res.setHeader("Transfer-Encoding", "chunked");
          }

          let collectedContent = "";
          let lastChunk = null;

          response.data.on("data", (chunk) => {
            res.write(chunk);
            const lines = chunk.toString().split("\n").filter((l) => l.trim());
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                // Ollama /api/chat streaming format
                if (parsed.message?.content) {
                  collectedContent += parsed.message.content;
                }
                // Ollama /api/chat thinking format (glm models put response in thinking)
                if (parsed.message?.thinking) {
                  collectedContent += parsed.message.thinking;
                }
                // Ollama /api/generate streaming format
                if (parsed.response) {
                  collectedContent += parsed.response;
                }
                // Anthropic streaming format
                if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                  collectedContent += parsed.delta.text;
                }
                // OpenAI streaming format
                if (parsed.choices?.[0]?.delta?.content) {
                  collectedContent += parsed.choices[0].delta.content;
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
            const provider = proxyBody.model.endsWith(":cloud") ? "ollama-cloud" : "ollama";
            const finalData = lastChunk || {};
            finalData._collectedCompletion = collectedContent;
            this.logOllamaCall({ requestId, requestBody: logBody, response: { data: finalData, status: 200, headers: response.headers }, latency, provider, isV1Endpoint })
              .catch((err) => console.error("Proxy log error:", err.message));
          });

          response.data.on("error", (streamErr) => {
            console.error("Stream error:", streamErr.message);
            res.end();
          });

        } else {
          // Non-streaming: buffer the full response
          const response = await axios({
            method: req.method,
            url: targetUrl,
            data: proxyBody,
            params: req.query,
            headers: proxyHeaders,
            timeout: 300000,
            responseType: "arraybuffer",
          });

          const latency = Date.now() - startTime;

          // Log the request asynchronously - use translated model name for logging
          if (isLoggable && response.status === 200) {
            const provider = proxyBody.model.endsWith(":cloud") ? "ollama-cloud" : "ollama";
            this.logOllamaCall({ requestId, requestBody: logBody, response, latency, provider, isV1Endpoint })
              .catch((err) => console.error("Proxy log error:", err.message));
          }

          // Forward the response exactly as-is
          const contentType = response.headers["content-type"] || "application/json";
          res.setHeader("Content-Type", contentType);
          res.status(response.status).send(response.data);
        }
      } catch (error) {
        const latency = Date.now() - startTime;

        if (isLoggable) {
          const provider = proxyBody.model.endsWith(":cloud") ? "ollama-cloud" : "ollama";
          this.logOllamaError({ requestId, requestBody: logBody, error, latency, provider })
            .catch((err) => console.error("Proxy log error:", err.message));
        }

        if (error.response) {
          const ct = error.response.headers["content-type"] || "application/json";
          res.setHeader("Content-Type", ct);
          res.status(error.response.status).send(error.response.data);
        } else {
          res.status(502).json({ error: `Ollama proxy: ${error.message}` });
        }
      }
    });

    const proxyServer = require("http").createServer(proxyApp);

    proxyServer.listen(OLLAMA_PROXY_PORT, "0.0.0.0", () => {
      console.log(`🔀 Ollama transparent proxy: http://localhost:${OLLAMA_PROXY_PORT} → ${OLLAMA_TARGET}`);
    });

    proxyServer.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.warn(`⚠️  Port ${OLLAMA_PROXY_PORT} in use - Ollama proxy not started (Ollama may be running on this port)`);
        console.warn(`   Stop Ollama or set OLLAMA_PROXY_PORT to a different port`);
      } else {
        console.error("❌ Ollama proxy error:", error);
      }
    });

    this.proxyServer = proxyServer;
  }

  /**
   * Log a successful Ollama call to the database
   */
  async logOllamaCall({ requestId, requestBody, response, latency, provider, isV1Endpoint = false }) {
    try {
      let responseData;
      // Handle streaming response (object with _collectedCompletion) vs buffered (arraybuffer)
      if (response.data && typeof response.data === "object" && !Buffer.isBuffer(response.data)) {
        responseData = response.data;
      } else {
        try {
          responseData = JSON.parse(Buffer.from(response.data).toString());
        } catch (e) {
          responseData = {};
        }
      }

      const prompt = this.extractPrompt(requestBody);
      // For streaming responses, use collected content; otherwise extract from response
      const completion = responseData._collectedCompletion || this.extractCompletion(responseData);
      const systemMessage = this.extractSystemMessage(requestBody);
      const model = requestBody.model || "unknown";

      // Extract tokens from response (Ollama format or Anthropic/OpenAI format)
      const promptTokens = responseData.prompt_eval_count ||
        responseData.usage?.input_tokens ||
        await tokenCounter.estimateOllamaTokens(prompt + " " + systemMessage);
      const completionTokens = responseData.eval_count ||
        responseData.usage?.output_tokens ||
        await tokenCounter.estimateOllamaTokens(completion);

      // Determine finish reason from various response formats
      const finishReason = responseData.done_reason ||
        (responseData.done ? "stop" : null) ||
        responseData.stop_reason ||
        (responseData.choices?.[0]?.finish_reason) || null;

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
        cost: { promptCost: 0, completionCost: 0, totalCost: 0, currency: "USD" },
        latency,
        status: "success",
        isStreaming: !!requestBody.stream,
        finishReason,
        createdAt: new Date(),
      });

      await logEntry.save();

      // Emit via WebSocket for real-time dashboard updates
      if (this.app.io) {
        this.app.io.to("logs").emit("new-log", {
          type: "new-log",
          data: logEntry.toObject(),
          timestamp: new Date(),
        });
      }
    } catch (err) {
      console.error("Failed to log proxied request:", err.message);
    }
  }

  /**
   * Log a failed Ollama call
   */
  async logOllamaError({ requestId, requestBody, error, latency, provider }) {
    try {
      const logEntry = new Log({
        requestId,
        provider,
        model: requestBody.model || "unknown",
        prompt: this.extractPrompt(requestBody).substring(0, 10000),
        completion: "",
        systemMessage: this.extractSystemMessage(requestBody).substring(0, 5000),
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

      if (this.app.io) {
        this.app.io.to("logs").emit("new-log", {
          type: "new-log",
          data: logEntry.toObject(),
          timestamp: new Date(),
        });
      }
    } catch (err) {
      console.error("Failed to log proxied error:", err.message);
    }
  }

  extractPrompt(body) {
    let prompt = "";
    if (body.messages && Array.isArray(body.messages)) {
      const userMsg = body.messages.find((m) => m.role === "user");
      prompt = extractContent(userMsg?.content);
    } else {
      prompt = extractContent(body.prompt);
    }
    return stripSystemContext(prompt);
  }

  extractSystemMessage(body) {
    if (body.messages && Array.isArray(body.messages)) {
      const sysMsg = body.messages.find((m) => m.role === "system");
      return extractContent(sysMsg?.content);
    }
    return extractContent(body.system);
  }

  extractCompletion(data) {
    if (!data) return "";
    if (data.message?.content) return extractContent(data.message.content);
    // glm models put response in message.thinking
    if (data.message?.thinking && !data.message?.content) return extractContent(data.message.thinking);
    if (data.response) return data.response;
    // Anthropic Messages API format
    if (data.content && Array.isArray(data.content)) {
      const textBlocks = data.content.filter(b => b.type === "text");
      if (textBlocks.length > 0) return textBlocks.map(b => b.text).join("\n");
      // If only thinking blocks (response cut short), extract thinking content
      const thinkingBlocks = data.content.filter(b => b.type === "thinking");
      if (thinkingBlocks.length > 0) return thinkingBlocks.map(b => b.thinking || b.text || "").join("\n");
    }
    // OpenAI Chat Completions format
    if (data.choices?.[0]?.message?.content) return extractContent(data.choices[0].message.content);
    if (data.choices?.[0]?.text) return data.choices[0].text;
    return "";
  }

  async displayProviderStatus() {
    try {
      const providers = {
        "Ollama Local": "🟡 Local (No API Key Required)",
        "Ollama Cloud": config.providers.ollamaCloud.apiKey
          ? "🟢 API Key Set"
          : "🔴 No API Key",
        OpenAI: config.providers.openai.apiKey
          ? "🟢 API Key Set"
          : "🔴 No API Key",
        OpenRouter: config.providers.openrouter.apiKey
          ? "🟢 API Key Set"
          : "🔴 No API Key",
        Mistral: config.providers.mistral.apiKey
          ? "🟢 API Key Set"
          : "🔴 No API Key",
        Gemini: config.providers.gemini.apiKey
          ? "🟢 API Key Set"
          : "🔴 No API Key",
        Grok: config.providers.grok.apiKey
          ? "🟢 API Key Set"
          : "🔴 No API Key",
      };

      console.log("\n📡 Provider Status:");
      Object.entries(providers).forEach(([name, status]) => {
        console.log(`  ${name}: ${status}`);
      });

      setTimeout(() => {
        this.testProviderConnections();
      }, 2000);
    } catch (error) {
      console.error("Error displaying provider status:", error);
    }
  }

  async testProviderConnections() {
    const services = {
      "Ollama Local": () => new (require("./services/ollamaService"))(),
      "Ollama Cloud": () => new (require("./services/ollamaCloudService"))(),
      OpenAI: () => new (require("./services/openaiService"))(),
      OpenRouter: () => new (require("./services/openrouterService"))(),
      Mistral: () => new (require("./services/mistralService"))(),
      Gemini: () => new (require("./services/geminiService"))(),
      Grok: () => new (require("./services/grokService"))(),
    };

    console.log("\n🔍 Testing provider connections...");

    for (const [name, createService] of Object.entries(services)) {
      try {
        const service = createService();
        const startTime = Date.now();
        const isConnected = await service.testConnection();
        const latency = Date.now() - startTime;

        if (isConnected) {
          console.log(`  ${name}: 🟢 Connected (${latency}ms)`);
        } else {
          console.log(`  ${name}: 🔴 Connection failed`);
        }
      } catch (error) {
        console.log(`  ${name}: 🔴 Error - ${error.message}`);
      }
    }

    console.log("\n🎉 Server initialization complete!\n");
  }

  async stop() {
    if (this.proxyServer) {
      this.proxyServer.close();
    }
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          console.log("👋 Server stopped");
          resolve();
        });
      });
    }
  }
}

if (require.main === module) {
  const server = new Server();
  server.start().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}

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
  // Remove content between <system-reminder> and </system-reminder> tags
  let cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  // Remove content between <claudeMd> and </claudeMd> tags
  cleaned = cleaned.replace(/<claudeMd>[\s\S]*?<\/claudeMd>/gi, "");
  // Remove leading/trailing whitespace and newlines
  cleaned = cleaned.trim();
  return cleaned || text;
}

module.exports = Server;