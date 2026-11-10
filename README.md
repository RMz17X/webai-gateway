# WebAI Gateway

Unified OpenAI-compatible API & Model Context Protocol (MCP) server for free web AI models: **Bing/Edge Copilot** and **Duck.ai** (GPT-6 Luna, GPT-5.4 mini, Claude Haiku 5.5, Mistral Small 4, Gemma 4 31B) with zero API keys required.

Includes full Microsoft Bing search scraping endpoints (Web, Image, and Reverse Visual Search).

---

## ✨ Features

- **OpenAI-Compatible Endpoints:** Drop-in replacement for OpenAI API clients (`/v1/models`, `/v1/chat/completions` non-streaming & SSE streaming).
- **Dual Engine Architecture:**
  - **Bing/Edge AI:** Direct scraping of Edge Copilot internal contextual chat endpoints.
  - **Duck.ai (Chrome CDP Bridge):** Chrome DevTools Protocol bridge (`127.0.0.1:9222`) driving a real browser tab to natively solve anti-bot challenges and stream responses from flagship models like **GPT-6 Luna** and **Claude Haiku 5.5**.
- **Bing Search Suite:** Web search v7 JSON fallback, high-resolution image search, and reverse visual image search.
- **Model Context Protocol (MCP) Server:** Built-in stdio MCP server for Claude Desktop, OpenBot, Cursor, and other agent harnesses.
- **Outbound Proxy Support:** Optional residential HTTP/HTTPS proxy forwarding via Undici `EnvHttpProxyAgent` while keeping local loopback CDP traffic direct.

---

## 🚀 Supported Models

### Duck.ai Engine (via Local Chrome CDP)
- `gpt-6-luna` (Default Duck model — OpenAI flagship with deep reasoning)
- `gpt-5.4-mini` (Fast lightweight OpenAI model)
- `claude-haiku-5-5` (Anthropic Claude Haiku 5.5)
- `mistral-small-2603` (Mistral Small 4)
- `tinfoil/gemma4-31b` (Google Gemma 4 31B)

### Bing / Edge Engine (Direct Upstream)
- `bing-copilot` (Default Bing model)
- `edge-ai`
- `gpt-4-bing`

---

## 📦 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health probe (reports Duck.ai CDP status & Bing engine status) |
| `GET` | `/v1/models` | List all available models (OpenAI format) |
| `POST` | `/v1/chat/completions` | Chat completions (JSON or Server-Sent Events stream) |
| `POST` | `/v1/completions` | Legacy completions endpoint |
| `GET / POST` | `/v1/search` | Bing web search (`?q=keyword&count=10`) |
| `GET / POST` | `/v1/images/search` | Bing image search (`?q=keyword&count=15`) |
| `POST` | `/v1/images/visual-search` | Reverse image search (`{ "imageUrl": "https://..." }`) |

---

## 🛠️ Quick Start

### 1. Prerequisites
- Node.js >= 20
- Google Chrome or Chromium (if using the Duck.ai engine)

### 2. Start Chrome with CDP Enabled (Required for Duck.ai)
```bash
google-chrome-stable \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-cdp-profile \
  --no-first-run \
  https://duck.ai/ &
```

### 3. Installation & Setup
```bash
git clone https://github.com/RMz17X/webai-gateway.git
cd webai-gateway
npm install

cp .env.example .env
# Edit .env to set PORT, optional API_KEY, or PROXY_URL
```

### 4. Run the Server
```bash
# Production server
npm start

# Development mode with hot reload
npm run dev
```

---

## 🔌 MCP Server Configuration

Add to your MCP client config (`~/.claude.json`, OpenBot, or Cursor):

```json
{
  "mcpServers": {
    "webai-gateway": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/webai-gateway/src/mcp-server.js"],
      "env": {
        "CDP_URL": "http://127.0.0.1:9222",
        "PROXY_URL": ""
      }
    }
  }
}
```

### Available MCP Tools:
- `duck_ask_ai`: Query Duck.ai models (`gpt-6-luna`, `claude-haiku-5-5`, etc.).
- `bing_ask_ai`: Query Microsoft Edge AI directly.
- `bing_web_search`: Organic Bing search with snippets and URLs.
- `bing_search_images`: High-res image results with direct and markdown links.
- `bing_visual_search`: Visual recognition and reverse image analysis.

---

## 💡 Usage Examples

### Chat Completions with GPT-6 Luna
```bash
curl -s http://127.0.0.1:8388/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "messages": [
      {"role": "user", "content": "Explain Redis caching strategies in 3 bullet points."}
    ],
    "stream": false
  }'
```

### Streaming Chat Completions (SSE)
```bash
curl -N http://127.0.0.1:8388/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-haiku-5-5",
    "messages": [
      {"role": "user", "content": "Write a short poem about Linux."}
    ],
    "stream": true
  }'
```

---

## 📄 License
ISC
