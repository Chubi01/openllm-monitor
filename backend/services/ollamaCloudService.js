const axios = require("axios");
const config = require("../config/env");
const retryHandler = require("../utils/retryHandler");

class OllamaCloudService {
  constructor() {
    this.baseUrl = config.providers.ollamaCloud.baseUrl;
    this.apiKey = config.providers.ollamaCloud.apiKey;

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "OpenLLM-Monitor/1.0",
        ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
      },
      timeout: 60000,
    });

    this.retryConfig = retryHandler.getProviderRetryConfig("ollama");
  }

  updateApiKey(apiKey) {
    this.apiKey = apiKey;
    if (apiKey) {
      this.client.defaults.headers.common["Authorization"] =
        `Bearer ${apiKey}`;
    } else {
      delete this.client.defaults.headers.common["Authorization"];
    }
  }

  updateBaseUrl(baseUrl) {
    this.baseUrl = baseUrl;
    this.client.defaults.baseURL = baseUrl;
  }

  async listModels() {
    try {
      // Ollama Cloud uses /api/tags (same as local Ollama)
      const response = await this.client.get("/api/tags");
      const models = response.data.models || [];
      return Array.isArray(models)
        ? models.map((m) => ({
            id: m.name || m.model,
            name: m.name || m.model,
            size: m.size || 0,
            modified: m.modified_at || null,
            digest: m.digest || "",
            details: m.details || {},
            type: "cloud",
          }))
        : [];
    } catch (error) {
      console.error("Error listing Ollama Cloud models:", error.message);
      if (error.response?.status === 401) {
        throw new Error("Invalid Ollama Cloud API key");
      }
      return [];
    }
  }

  async sendPrompt(params) {
    const {
      prompt,
      model = "kimi-k2.5:latest",
      systemMessage = "",
      temperature = 0.7,
      maxTokens = null,
      requestId,
      images = [],
    } = params;

    const startTime = Date.now();

    try {
      const messages = [];
      if (systemMessage) {
        messages.push({ role: "system", content: systemMessage });
      }

      const userContent = images.length > 0
        ? { content: prompt, images }
        : prompt;

      messages.push({ role: "user", content: userContent });

      const requestBody = {
        model,
        messages,
        stream: false,
        options: {
          temperature,
          ...(maxTokens && { num_predict: maxTokens }),
        },
      };

      const { result, retryHistory } = await retryHandler.executeWithRetry(
        async () => {
          const response = await this.client.post("/api/chat", requestBody);
          return response.data;
        },
        this.retryConfig
      );

      const endTime = Date.now();
      const latency = endTime - startTime;
      const completion = result.message?.content || "";

      const promptTokens = result.prompt_eval_count || 0;
      const completionTokens = result.eval_count || 0;
      const totalTokens = promptTokens + completionTokens;

      return {
        requestId,
        provider: "ollama-cloud",
        model,
        prompt,
        completion,
        systemMessage,
        parameters: { temperature, maxTokens },
        tokenUsage: {
          promptTokens,
          completionTokens,
          totalTokens,
        },
        cost: { promptCost: 0, completionCost: 0, totalCost: 0, currency: "USD" },
        latency,
        retryHistory,
        status: "success",
        rawResponse: result,
        finishReason: result.done_reason || "stop",
      };
    } catch (error) {
      const endTime = Date.now();
      return {
        requestId,
        provider: "ollama-cloud",
        model,
        prompt,
        completion: "",
        systemMessage,
        parameters: { temperature, maxTokens },
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        cost: { promptCost: 0, completionCost: 0, totalCost: 0, currency: "USD" },
        latency: endTime - startTime,
        retryHistory: error.retryHistory || [],
        status: this.getErrorStatus(error),
        error: {
          message: error.message,
          code: error.code || error.response?.status,
          details: error.response?.data || {},
        },
      };
    }
  }

  async testConnection() {
    try {
      const response = await this.client.get("/api/tags");
      return response.status === 200;
    } catch (localErr) {
      // /api/tags may not exist on cloud; try /api/models instead
      try {
        const response = await this.client.get("/api/models");
        return response.status === 200;
      } catch (cloudErr) {
        console.error("Ollama Cloud connection test failed:", cloudErr.message);
        return false;
      }
    }
  }

  getErrorStatus(error) {
    if (error.response) {
      const status = error.response.status;
      if (status === 401) return "auth_error";
      if (status === 429) return "rate_limited";
      if (status >= 500) return "error";
      if (status === 404) return "error";
    }
    if (error.code === "ECONNABORTED" || error.message.includes("timeout")) return "timeout";
    if (error.code === "ECONNREFUSED") return "error";
    return "error";
  }
}

module.exports = OllamaCloudService;