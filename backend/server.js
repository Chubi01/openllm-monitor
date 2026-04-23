const App = require("./app");
const config = require("./config/env");
const database = require("./config/db");
const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const {
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
  translateModel,
  logOllamaCall,
  logOllamaError,
} = require("./utils/proxyHelpers");

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

    // Catch-all: proxy every request to Ollama
    proxyApp.all("*", async (req, res) => {
      const targetUrl = `${OLLAMA_TARGET}${req.originalUrl}`;
      const shouldLog = isLoggable(req.originalUrl);
      const requestId = uuidv4();
      const startTime = Date.now();

      // Determine provider based on URL path and model
      const isV1Endpoint = req.originalUrl.includes("/v1/messages") || req.originalUrl.includes("/v1/chat/completions");

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

      // For logging: preserve the original model name alongside the translated one
      const logBody = { ...requestBody, model: proxyBody.model, originalModel };

      // Build proxy headers: use Ollama Cloud API key for cloud models
      const proxyHeaders = {
        "Content-Type": req.get("Content-Type") || "application/json",
      };
      if (proxyBody.model.endsWith(":cloud") && config.providers.ollamaCloud.apiKey) {
        proxyHeaders["Authorization"] = `Bearer ${config.providers.ollamaCloud.apiKey}`;
      } else if (req.get("Authorization")) {
        proxyHeaders["Authorization"] = req.get("Authorization");
      }

      const stream = isStreamRequest(proxyBody);

      try {
        if (stream && shouldLog) {
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

          const collected = createStreamCollector();

          response.data.on("data", (chunk) => {
            res.write(chunk);
            const lines = chunk.toString().split("\n");
            for (const line of lines) {
              const parsed = parseStreamLine(line);
              if (parsed) collectStreamContent(parsed, collected);
            }
          });

          response.data.on("end", () => {
            res.end();
            const latency = Date.now() - startTime;
            const provider = proxyBody.model.endsWith(":cloud") ? "ollama-cloud" : "ollama";
            logOllamaCall({ requestId, requestBody: logBody, response: { data: collected.doneChunk || {}, status: 200, headers: response.headers }, latency, provider, isV1Endpoint, collected })
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

          // Log the request asynchronously
          if (shouldLog && response.status === 200) {
            const provider = proxyBody.model.endsWith(":cloud") ? "ollama-cloud" : "ollama";
            logOllamaCall({ requestId, requestBody: logBody, response, latency, provider, isV1Endpoint, collected: null })
              .catch((err) => console.error("Proxy log error:", err.message));
          }

          // Forward the response exactly as-is
          const contentType = response.headers["content-type"] || "application/json";
          res.setHeader("Content-Type", contentType);
          res.status(response.status).send(response.data);
        }
      } catch (error) {
        const latency = Date.now() - startTime;

        if (shouldLog) {
          const provider = proxyBody.model.endsWith(":cloud") ? "ollama-cloud" : "ollama";
          logOllamaError({ requestId, requestBody: logBody, error, latency, provider })
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

module.exports = Server;