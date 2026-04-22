# OpenLLM Monitor

Real-time LLM observability dashboard. Monitor prompts, costs, latency, and token usage across multiple providers.

## Providers

| Provider | Type | API |
|----------|------|-----|
| Ollama Local | Local | `localhost:11434` |
| Ollama Cloud | Cloud | `api.ollama.com` |
| OpenAI | Cloud | `api.openai.com` |
| OpenRouter | Cloud | `openrouter.ai` |
| Mistral | Cloud | `mistral.ai` |
| Gemini | Cloud | `generativelanguage.googleapis.com` |
| Grok | Cloud | `api.x.ai` |

## Quick Start

```bash
# Copy env file and add your API keys
cp .env.example .env

# Start the stack
docker compose up -d

# Open dashboard
open http://localhost:4180
```

## Ports

| Service | Port |
|---------|------|
| Frontend | 4180 |
| Backend API | 3001 |
| MongoDB | 27018 |
| Ollama Proxy | 11436 |

## Transparent Proxy

The dashboard includes a transparent Ollama proxy on port **11436** that intercepts all LLM requests and logs them automatically. Point your apps to the proxy instead of directly to Ollama:

```bash
# Instead of: ANTHROPIC_BASE_URL=http://localhost:11434
# Use:         ANTHROPIC_BASE_URL=http://localhost:11436
```

### Features

- **Model mapping**: Claude model names auto-map to Ollama equivalents (e.g. `claude-3-5-sonnet` → `glm-5.1:cloud`)
- **Prompt cleanup**: System context tags (`<system-reminder>`, `<claudeMd>`) are stripped so the dashboard shows the actual user message
- **Streaming support**: Streaming responses are proxied in real-time and the full completion is captured for logging
- **Thinking capture**: Models that put responses in `message.thinking` (e.g. glm-5.1) are handled correctly

### claude-ollama alias

```bash
function claude-ollama {
  local model="${1:-glm-5.1:cloud}"
  [ -n "$1" ] && shift
  ANTHROPIC_BASE_URL="http://localhost:11436" \
    claude --remote-control --model "$model" --dangerously-skip-permissions "$@"
}
```

## Architecture

```
frontend/   React + Vite + Tailwind + Zustand
backend/    Express + MongoDB + Socket.IO
docker-compose.yml
```

## License

MIT