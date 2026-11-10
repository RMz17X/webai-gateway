// OpenAI API compatibility adapter for Edge AI, Bing & Duck.ai

import crypto from "node:crypto";
import { DUCK_SUPPORTED_MODELS } from "./duck.js";

export const BING_SUPPORTED_MODELS = [
  {
    id: "bing-copilot",
    object: "model",
    created: 1700000000,
    owned_by: "microsoft-edge",
    permission: [],
    root: "bing-copilot",
    parent: null
  },
  {
    id: "edge-ai",
    object: "model",
    created: 1700000000,
    owned_by: "microsoft-edge",
    permission: [],
    root: "edge-ai",
    parent: null
  },
  {
    id: "gpt-4-bing",
    object: "model",
    created: 1700000000,
    owned_by: "microsoft-edge",
    permission: [],
    root: "gpt-4-bing",
    parent: null
  }
];

export const DUCK_MODEL_LIST = DUCK_SUPPORTED_MODELS.map((m) => ({
  id: m.id,
  object: "model",
  created: 1700000000,
  owned_by: `duckduckgo-${m.provider}`,
  permission: [],
  root: m.id,
  parent: null
}));

// Unified model registry: Bing/Edge models + Duck.ai models.
export const SUPPORTED_MODELS = [...BING_SUPPORTED_MODELS, ...DUCK_MODEL_LIST];

export function generateChatId() {
  return "chatcmpl-" + crypto.randomBytes(12).toString("hex");
}

export function estimateTokens(text) {
  if (!text || typeof text !== "string") return 0;
  return Math.ceil(text.length / 3.8);
}

export function parseOpenAiMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      systemPrompt: "",
      prompt: "",
      lang: "id"
    };
  }

  const systemParts = [];
  const conversationParts = [];

  for (const msg of messages) {
    const role = msg.role || "user";
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .map((part) => (typeof part === "string" ? part : part?.text || ""))
        .join(" ");
    }

    if (role === "system") {
      systemParts.push(content);
    } else if (role === "user") {
      conversationParts.push(`User: ${content}`);
    } else if (role === "assistant") {
      conversationParts.push(`Assistant: ${content}`);
    }
  }

  // If there's only 1 user message and no previous history, send just the message content
  let prompt = "";
  if (conversationParts.length === 1 && conversationParts[0].startsWith("User: ")) {
    prompt = conversationParts[0].slice(6);
  } else {
    prompt = conversationParts.join("\n\n");
  }

  const systemPrompt = systemParts.join("\n\n");

  // Simple language heuristic for Indonesian vs English
  const combined = `${systemPrompt} ${prompt}`.toLowerCase();
  const indoHits = (combined.match(/\b(yang|dan|di|ini|itu|ke|dari|untuk|bisa|saya|kamu|tolong|bagaimana|buatkan)\b/g) || []).length;
  const lang = indoHits > 0 ? "id" : "en";

  return {
    systemPrompt,
    prompt,
    lang
  };
}

export function formatNonStreamingResponse({ id, model, content, promptTokens }) {
  const completionTokens = estimateTokens(content);
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "bing-copilot",
    system_fingerprint: "fp_bing_edge",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content
        },
        logprobs: null,
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  };
}

export function formatChunkResponse({ id, model, created, delta, finishReason = null }) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model: model || "bing-copilot",
    system_fingerprint: "fp_bing_edge",
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      }
    ]
  };
}
