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

## Architecture

```
frontend/   React + Vite + Tailwind + Zustand
backend/    Express + MongoDB + Socket.IO
docker-compose.yml
```

## License

MIT