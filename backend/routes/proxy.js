const express = require("express");
const router = express.Router();
const axios = require("axios");
const config = require("../config/env");
const { v4: uuidv4 } = require("uuid");
const {
  isLoggable,
  isStreamRequest,
  translateModel,
  MODEL_MAP,
  parseStreamLine,
  collectStreamContent,
  createStreamCollector,
  logOllamaCall,
  logOllamaError,
} = require("../utils/proxyHelpers");

/**
 * Proxy routes for Ollama Local and Ollama Cloud
 *
 * These routes forward requests to Ollama and log them
 * so that ALL LLM calls appear in the dashboard, not just
 * those made through the /api/providers/:provider/complete endpoint.
 */

// ── Shared streaming handler ────────────────────────────────────────

async function handleStreamingProxy({ req, res, targetUrl, headers, provider, isV1Endpoint }) {
  const requestId = uuidv4();
  const startTime = Date.now();
  const requestBody = req.body || {};
  const originalModel = requestBody.model;
  const proxyBody = { ...requestBody };
  if (MODEL_MAP[proxyBody.model]) proxyBody.model = MODEL_MAP[proxyBody.model];
  const logBody = { ...requestBody, model: proxyBody.model, originalModel };

  const proxyHeaders = { ...headers };
  if (proxyBody.model.endsWith(":cloud") && config.providers.ollamaCloud.apiKey) {
    proxyHeaders["Authorization"] = `Bearer ${config.providers.ollamaCloud.apiKey}`;
  } else if (req.get("Authorization")) {
    proxyHeaders["Authorization"] = req.get("Authorization");
  }

  try {
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
      logOllamaCall({
        requestId,
        requestBody: logBody,
        response: { data: collected.doneChunk || {}, status: 200, headers: response.headers },
        latency,
        provider,
        isV1Endpoint,
        collected,
      }).catch((err) => console.error("Proxy log error:", err.message));
    });

    response.data.on("error", (streamErr) => {
      console.error("Stream error:", streamErr.message);
      res.end();
    });
  } catch (error) {
    const latency = Date.now() - startTime;

    logOllamaError({
      requestId,
      requestBody: logBody,
      error,
      latency,
      provider,
    }).catch((err) => console.error("Proxy log error:", err.message));

    if (error.response) {
      const ct = error.response.headers["content-type"] || "application/json";
      res.setHeader("Content-Type", ct);
      res.status(error.response.status).send(error.response.data);
    } else {
      res.status(502).json({ error: `Ollama proxy: ${error.message}` });
    }
  }
}

async function handleNonStreamingProxy({ req, res, targetUrl, headers, provider, isV1Endpoint }) {
  const requestId = uuidv4();
  const startTime = Date.now();
  const requestBody = req.body || {};
  const originalModel = requestBody.model;
  const proxyBody = { ...requestBody };
  if (MODEL_MAP[proxyBody.model]) proxyBody.model = MODEL_MAP[proxyBody.model];
  const logBody = { ...requestBody, model: proxyBody.model, originalModel };

  const proxyHeaders = { ...headers };
  if (proxyBody.model.endsWith(":cloud") && config.providers.ollamaCloud.apiKey) {
    proxyHeaders["Authorization"] = `Bearer ${config.providers.ollamaCloud.apiKey}`;
  } else if (req.get("Authorization")) {
    proxyHeaders["Authorization"] = req.get("Authorization");
  }

  try {
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

    if (response.status === 200) {
      logOllamaCall({
        requestId,
        requestBody: logBody,
        response,
        latency,
        provider,
        isV1Endpoint,
        collected: null,
      }).catch((err) => console.error("Proxy log error:", err.message));
    }

    const contentType = response.headers["content-type"] || "application/json";
    res.setHeader("Content-Type", contentType);
    res.status(response.status).send(response.data);
  } catch (error) {
    const latency = Date.now() - startTime;

    logOllamaError({
      requestId,
      requestBody: logBody,
      error,
      latency,
      provider,
    }).catch((err) => console.error("Proxy log error:", err.message));

    if (error.response) {
      const ct = error.response.headers["content-type"] || "application/json";
      res.setHeader("Content-Type", ct);
      res.status(error.response.status).send(error.response.data);
    } else {
      res.status(502).json({ error: `Ollama proxy: ${error.message}` });
    }
  }
}

// ── Ollama Local Proxy ──────────────────────────────────────────────

router.all("/ollama/*", async (req, res) => {
  const ollamaBase = config.providers.ollama.baseUrl;
  const targetPath = req.params[0] ? `/${req.params[0]}` : "/api/tags";
  const targetUrl = `${ollamaBase}${targetPath}`;

  const requestBody = req.body || {};
  const stream = isStreamRequest(requestBody);
  const isV1Endpoint = targetPath.includes("/v1/messages") || targetPath.includes("/v1/chat/completions");
  const provider = requestBody.model?.endsWith(":cloud") ? "ollama-cloud" : "ollama";

  const commonArgs = {
    req, res, targetUrl,
    headers: { "Content-Type": "application/json" },
    provider,
    isV1Endpoint,
  };

  if (stream && isLoggable(targetPath)) {
    await handleStreamingProxy(commonArgs);
  } else {
    await handleNonStreamingProxy(commonArgs);
  }
});

// ── Ollama Cloud Proxy ───────────────────────────────────────────────

router.all("/ollama-cloud/*", async (req, res) => {
  const cloudBase = config.providers.ollamaCloud.baseUrl;
  const targetPath = req.params[0] ? `/${req.params[0]}` : "/api/tags";
  const targetUrl = `${cloudBase}${targetPath}`;

  const requestBody = req.body || {};
  const stream = isStreamRequest(requestBody);
  const isV1Endpoint = targetPath.includes("/v1/messages") || targetPath.includes("/v1/chat/completions");

  const headers = { "Content-Type": "application/json" };
  if (config.providers.ollamaCloud.apiKey) {
    headers["Authorization"] = `Bearer ${config.providers.ollamaCloud.apiKey}`;
  }

  const commonArgs = {
    req, res, targetUrl,
    headers,
    provider: "ollama-cloud",
    isV1Endpoint,
  };

  if (stream && isLoggable(targetPath)) {
    await handleStreamingProxy(commonArgs);
  } else {
    await handleNonStreamingProxy(commonArgs);
  }
});

module.exports = router;