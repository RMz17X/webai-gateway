import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { search, searchImages, visualSearch, askAiStream, askAi } from "./bing.js";
import {
  askDuckStream,
  askDuck,
  duckHealth,
  isDuckModel,
  DEFAULT_DUCK_MODEL,
  DUCK_SUPPORTED_MODELS
} from "./duck.js";
import {
  SUPPORTED_MODELS,
  BING_SUPPORTED_MODELS,
  generateChatId,
  estimateTokens,
  parseOpenAiMessages,
  formatNonStreamingResponse,
  formatChunkResponse
} from "./openai.js";

dotenv.config();

// Global Outbound Proxy Dispatcher (optional).
// EnvHttpProxyAgent honours NO_PROXY, so loopback CDP traffic (127.0.0.1:9222)
// stays direct while public traffic still goes through the proxy.
const PROXY_URL = process.env.PROXY_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "";
if (PROXY_URL) {
  try {
    if (!process.env.NO_PROXY) {
      process.env.NO_PROXY = "localhost,127.0.0.1,::1";
    }
    if (!process.env.HTTP_PROXY) process.env.HTTP_PROXY = PROXY_URL;
    if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = PROXY_URL;
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log(`[webai-gateway] Outbound proxy configured: ${PROXY_URL}`);
  } catch (err) {
    console.error(`[webai-gateway] Failed to setup proxy ${PROXY_URL}:`, err.message);
  }
}

const app = express();
const PORT = process.env.PORT || 8388;
const HOST = process.env.HOST || "0.0.0.0";
const API_KEY = process.env.API_KEY || "";

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Optional API Key Auth Middleware
app.use((req, res, next) => {
  // Public health check
  if (req.path === "/" || req.path === "/health") {
    return next();
  }

  if (!API_KEY) {
    return next(); // Open mode (Tailscale / local network)
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : req.query.key || req.headers["x-api-key"] || "";

  if (token !== API_KEY) {
    return res.status(401).json({
      error: {
        message: "Incorrect API key provided.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_api_key"
      }
    });
  }

  next();
});

// Health & Root Status
app.get(["/", "/health"], async (req, res) => {
  const duck = await duckHealth();
  res.json({
    status: "ok",
    service: "webai-gateway",
    version: "2.0.0",
    authRequired: Boolean(API_KEY),
    engines: {
      bing: {
        status: "ok",
        models: BING_SUPPORTED_MODELS.map((m) => m.id)
      },
      duck: {
        status: duck.ok ? "ok" : "degraded",
        reason: duck.reason,
        cdpUrl: duck.cdpUrl,
        defaultModel: DEFAULT_DUCK_MODEL,
        models: DUCK_SUPPORTED_MODELS.map((m) => m.id)
      }
    },
    endpoints: {
      models: "GET /v1/models",
      chatCompletions: "POST /v1/chat/completions",
      completions: "POST /v1/completions",
      webSearch: "GET|POST /v1/search",
      imageSearch: "GET|POST /v1/images/search",
      visualSearch: "POST /v1/images/visual-search"
    }
  });
});

// OpenAI: GET /v1/models
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: SUPPORTED_MODELS
  });
});

app.get("/v1/models/:model", (req, res) => {
  const model = SUPPORTED_MODELS.find((m) => m.id === req.params.model);
  if (!model) {
    return res.status(404).json({
      error: {
        message: `The model '${req.params.model}' does not exist`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found"
      }
    });
  }
  res.json(model);
});

// OpenAI: POST /v1/chat/completions
app.post("/v1/chat/completions", async (req, res) => {
  const {
    model = "bing-copilot",
    messages = [],
    stream = false,
    temperature = 0.7,
    max_tokens = 4096
  } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: "Field 'messages' must be a non-empty array",
        type: "invalid_request_error",
        param: "messages",
        code: null
      }
    });
  }

  const { systemPrompt, prompt, lang } = parseOpenAiMessages(messages);
  const promptTokens = estimateTokens(`${systemPrompt} ${prompt}`);
  const chatId = generateChatId();
  const created = Math.floor(Date.now() / 1000);

  // Smart routing: Duck.ai models go to the Duck engine, everything else to Bing/Edge.
  const useDuck = isDuckModel(model);

  // Duck.ai keeps a real conversation in the browser tab, so the full message
  // history is forwarded. Bing/Edge uses the flattened prompt above.
  const duckOptions = {
    model,
    systemPrompt,
    messages,
    newChat: messages.length <= 1
  };

  // Streaming Mode (SSE)
  if (stream) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let isAborted = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        isAborted = true;
      }
    });

    try {
      // 1. Initial role chunk
      const roleChunk = formatChunkResponse({
        id: chatId,
        model,
        created,
        delta: { role: "assistant" }
      });
      res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

      // 2. Stream content chunks
      const streamSource = useDuck
        ? askDuckStream(prompt, duckOptions)
        : askAiStream(prompt, { systemPrompt, lang });

      for await (const chunk of streamSource) {
        if (isAborted) break;
        const textChunk = formatChunkResponse({
          id: chatId,
          model,
          created,
          delta: { content: chunk }
        });
        res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
      }

      // 3. Final chunk with finish_reason: stop
      if (!isAborted) {
        const finalChunk = formatChunkResponse({
          id: chatId,
          model,
          created,
          delta: {},
          finishReason: "stop"
        });
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({
          error: {
            message: err.message || "Upstream AI error",
            type: "upstream_error",
            param: null,
            code: 502
          }
        });
      } else {
        const errChunk = {
          error: {
            message: err.message || "Streaming interrupted",
            type: "server_error"
          }
        };
        res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
        res.end();
      }
    }
    return;
  }

  // Non-streaming Mode
  try {
    const fullText = useDuck
      ? await askDuck(prompt, duckOptions)
      : await askAi(prompt, { systemPrompt, lang });
    const responsePayload = formatNonStreamingResponse({
      id: chatId,
      model,
      content: fullText,
      promptTokens
    });
    res.json(responsePayload);
  } catch (err) {
    res.status(502).json({
      error: {
        message: err.message || "Upstream AI error",
        type: "upstream_error",
        param: null,
        code: 502
      }
    });
  }
});

// OpenAI: POST /v1/completions (Legacy text completions mapping)
app.post("/v1/completions", async (req, res) => {
  const { model = "bing-copilot", prompt = "", stream = false } = req.body || {};
  const messages = [{ role: "user", content: prompt }];

  // Express 5 removed the private app._router handle, so the legacy endpoint
  // cannot delegate to the chat handler. It shares the same routing helpers
  // and response shape instead of duplicating the streaming logic.
  const { systemPrompt, prompt: flatPrompt, lang } = parseOpenAiMessages(messages);
  const promptTokens = estimateTokens(`${systemPrompt} ${flatPrompt}`);
  const chatId = generateChatId();
  const created = Math.floor(Date.now() / 1000);
  const useDuck = isDuckModel(model);

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let isAborted = false;
    res.on("close", () => {
      if (!res.writableEnded) isAborted = true;
    });

    try {
      res.write(
        `data: ${JSON.stringify(
          formatChunkResponse({ id: chatId, model, created, delta: { role: "assistant" } })
        )}\n\n`
      );

      const streamSource = useDuck
        ? askDuckStream(flatPrompt, { model, systemPrompt, messages, newChat: true })
        : askAiStream(flatPrompt, { systemPrompt, lang });

      for await (const chunk of streamSource) {
        if (isAborted) break;
        res.write(
          `data: ${JSON.stringify(
            formatChunkResponse({ id: chatId, model, created, delta: { content: chunk } })
          )}\n\n`
        );
      }

      if (!isAborted) {
        res.write(
          `data: ${JSON.stringify(
            formatChunkResponse({ id: chatId, model, created, delta: {}, finishReason: "stop" })
          )}\n\n`
        );
        res.write("data: [DONE]\n\n");
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({
          error: { message: err.message || "Upstream AI error", type: "upstream_error", code: 502 }
        });
      } else {
        res.write(
          `data: ${JSON.stringify({ error: { message: err.message || "Streaming interrupted", type: "server_error" } })}\n\n`
        );
        res.end();
      }
    }
    return;
  }

  try {
    const fullText = useDuck
      ? await askDuck(flatPrompt, { model, systemPrompt, messages, newChat: true })
      : await askAi(flatPrompt, { systemPrompt, lang });
    res.json(formatNonStreamingResponse({ id: chatId, model, content: fullText, promptTokens }));
  } catch (err) {
    res.status(502).json({
      error: { message: err.message || "Upstream AI error", type: "upstream_error", code: 502 }
    });
  }
});

// Extended: Web Search
app.all("/v1/search", async (req, res) => {
  const query = req.method === "POST" ? req.body?.q || req.body?.query : req.query.q || req.query.query;
  const count = req.method === "POST" ? req.body?.count : req.query.count;
  const offset = req.method === "POST" ? req.body?.offset : req.query.offset;
  const lang = req.method === "POST" ? req.body?.lang : req.query.lang;
  const country = req.method === "POST" ? req.body?.country : req.query.country;

  if (!query) {
    return res.status(400).json({
      error: {
        message: "Missing query parameter 'q'",
        type: "invalid_request_error"
      }
    });
  }

  try {
    const results = await search(query, { count, offset, lang, country });
    res.json({
      object: "search.results",
      query,
      count: results.length,
      data: results
    });
  } catch (err) {
    res.status(500).json({
      error: {
        message: err.message || "Bing search failed",
        type: "search_error"
      }
    });
  }
});

// Extended: Image Search
app.all("/v1/images/search", async (req, res) => {
  const query = req.method === "POST" ? req.body?.q || req.body?.query : req.query.q || req.query.query;
  const count = req.method === "POST" ? req.body?.count : req.query.count;
  const offset = req.method === "POST" ? req.body?.offset : req.query.offset;

  if (!query) {
    return res.status(400).json({
      error: {
        message: "Missing query parameter 'q'",
        type: "invalid_request_error"
      }
    });
  }

  try {
    const results = await searchImages(query, { count, offset });
    res.json({
      object: "image_search.results",
      query,
      count: results.length,
      data: results
    });
  } catch (err) {
    res.status(500).json({
      error: {
        message: err.message || "Bing image search failed",
        type: "image_search_error"
      }
    });
  }
});

// Extended: Visual Search (Reverse Image Search)
app.post("/v1/images/visual-search", async (req, res) => {
  const { imageUrl, image_url, count = 10 } = req.body || {};
  const targetUrl = imageUrl || image_url;

  if (!targetUrl) {
    return res.status(400).json({
      error: {
        message: "Missing 'imageUrl' in request body",
        type: "invalid_request_error"
      }
    });
  }

  try {
    const results = await visualSearch(targetUrl, { count });
    res.json({
      object: "visual_search.results",
      data: results
    });
  } catch (err) {
    res.status(500).json({
      error: {
        message: err.message || "Visual search failed",
        type: "visual_search_error"
      }
    });
  }
});

// Engine-specific health probe
app.get("/v1/health/:engine", async (req, res) => {
  const engine = req.params.engine;
  if (engine === "duck") {
    const duck = await duckHealth();
    return res.status(duck.ok ? 200 : 503).json({ engine, ...duck });
  }
  if (engine === "bing") {
    return res.json({
      engine,
      ok: true,
      models: BING_SUPPORTED_MODELS.map((m) => m.id)
    });
  }
  res.status(404).json({
    error: { message: `Unknown engine '${engine}'`, type: "invalid_request_error" }
  });
});

app.listen(PORT, HOST, () => {
  console.log(`[webai-gateway] Server running on http://${HOST}:${PORT}`);
  console.log(`[webai-gateway] OpenAI Chat Completions: http://${HOST}:${PORT}/v1/chat/completions`);
  console.log(`[webai-gateway] Engines: bing/edge + duck.ai (default model: ${DEFAULT_DUCK_MODEL})`);
});
