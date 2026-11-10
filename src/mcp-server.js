#!/usr/bin/env node

import dotenv from "dotenv";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { search, searchImages, visualSearch, askAi } from "./bing.js";
import { askDuck, DEFAULT_DUCK_MODEL, DUCK_SUPPORTED_MODELS } from "./duck.js";

dotenv.config();

// Setup proxy if configured (optional).
// EnvHttpProxyAgent honours NO_PROXY so the loopback CDP bridge stays direct.
const PROXY_URL = process.env.PROXY_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "";
if (PROXY_URL) {
  try {
    if (!process.env.NO_PROXY) {
      process.env.NO_PROXY = "localhost,127.0.0.1,::1";
    }
    if (!process.env.HTTP_PROXY) process.env.HTTP_PROXY = PROXY_URL;
    if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = PROXY_URL;
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch (err) {
    console.error(`[MCP] Failed to configure proxy ${PROXY_URL}:`, err.message);
  }
}

// Create MCP Server instance
const server = new McpServer({
  name: "webai-gateway-mcp",
  version: "2.0.0"
});

// Tool 1: bing_search_images
server.tool(
  "bing_search_images",
  "Search for images on Microsoft Bing. Returns direct high-resolution image URLs, thumbnails, dimensions, titles, and source websites.",
  {
    query: z.string().describe("The search query for images, e.g. 'futuristic server farm'"),
    count: z.number().int().min(1).max(50).default(15).optional().describe("Number of images to return (default: 15)"),
    offset: z.number().int().min(0).default(0).optional().describe("Pagination offset (default: 0)")
  },
  async ({ query, count = 15, offset = 0 }) => {
    try {
      const results = await searchImages(query, { count, offset });
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No images found for query: "${query}"`
            }
          ]
        };
      }

      const formattedText = results
        .map((img, i) => {
          return `${i + 1}. **${img.title || "Untitled"}**\n   - Direct Image: ${img.url}\n   - Thumbnail: ${img.thumbnailUrl}\n   - Source Page: ${img.sourceUrl}\n   - Markdown: ![${img.title || "image"}](${img.url})`;
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} images for "${query}":\n\n${formattedText}`
          }
        ]
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Image search error: ${err.message}`
          }
        ]
      };
    }
  }
);

// Tool 2: bing_web_search
server.tool(
  "bing_web_search",
  "Search the web using Microsoft Bing. Returns organic web results including titles, destination URLs, and text snippets.",
  {
    query: z.string().describe("Search query for web pages"),
    count: z.number().int().min(1).max(30).default(10).optional().describe("Number of results to return (default: 10)"),
    offset: z.number().int().min(0).default(0).optional().describe("Pagination offset (default: 0)"),
    lang: z.string().default("id").optional().describe("Language code (e.g. 'id', 'en')"),
    country: z.string().default("ID").optional().describe("Country code (e.g. 'ID', 'US')")
  },
  async ({ query, count = 10, offset = 0, lang = "id", country = "ID" }) => {
    try {
      const results = await search(query, { count, offset, lang, country });
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No web search results found for query: "${query}"`
            }
          ]
        };
      }

      const formatted = results
        .map((item, i) => `${i + 1}. [${item.title}](${item.url})\n   ${item.snippet}`)
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} results for "${query}":\n\n${formatted}`
          }
        ]
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Web search error: ${err.message}`
          }
        ]
      };
    }
  }
);

// Tool 3: bing_visual_search (Reverse Image Search)
server.tool(
  "bing_visual_search",
  "Reverse image search using Bing Visual Search. Analyzes an image URL to recognize subjects, OCR text, and find visually similar images.",
  {
    imageUrl: z.string().url().describe("Publicly accessible image URL to analyze"),
    count: z.number().int().min(1).max(30).default(10).optional().describe("Number of similar images to return (default: 10)")
  },
  async ({ imageUrl, count = 10 }) => {
    try {
      const result = await visualSearch(imageUrl, { count });
      let output = `**Visual Search Analysis**\n- Image: ${imageUrl}\n- Recognized Query: ${result.recognizedQuery || "N/A"}\n- BCID: ${result.bcid || "N/A"}\n\n`;

      if (result.similarImages && result.similarImages.length > 0) {
        output += `**Similar Images (${result.similarImages.length}):**\n` +
          result.similarImages.map((img, i) => `${i + 1}. [${img.title || "Image"}](${img.url}) (Source: ${img.sourceUrl})`).join("\n");
      } else {
        output += "No similar images found.";
      }

      return {
        content: [
          {
            type: "text",
            text: output
          }
        ]
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Visual search error: ${err.message}`
          }
        ]
      };
    }
  }
);

// Tool 4: bing_ask_ai
server.tool(
  "bing_ask_ai",
  "Query Microsoft Edge AI / Copilot model directly. Free, fast, structured answers without requiring an API key or account login.",
  {
    prompt: z.string().describe("The user prompt or query to ask the AI model"),
    systemPrompt: z.string().optional().describe("Optional instructions or persona for the model"),
    lang: z.string().default("id").optional().describe("Language code ('id' or 'en')")
  },
  async ({ prompt, systemPrompt = "", lang = "id" }) => {
    try {
      const answer = await askAi(prompt, { systemPrompt, lang });
      return {
        content: [
          {
            type: "text",
            text: answer
          }
        ]
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Edge AI error: ${err.message}`
          }
        ]
      };
    }
  }
);

// Tool 5: duck_ask_ai (Duck.ai Engine supporting GPT-6 Luna, GPT-5.6 Terra, Claude Haiku 5.5)
server.tool(
  "duck_ask_ai",
  "Query Duck.ai models directly via the local Chrome CDP bridge. Free, fast, privacy-preserving, supports GPT-6 Luna, GPT-5.6 Terra, Claude Haiku 5.5 without API keys.",
  {
    prompt: z.string().describe("The user prompt or query to ask the Duck.ai model"),
    model: z
      .string()
      .default(DEFAULT_DUCK_MODEL)
      .optional()
      .describe(
        `Duck.ai model to use (default: '${DEFAULT_DUCK_MODEL}'). Supported: ${DUCK_SUPPORTED_MODELS.map((m) => m.id).join(", ")}`
      ),
    systemPrompt: z.string().optional().describe("Optional system instructions or persona for the model")
  },
  async ({ prompt, model = DEFAULT_DUCK_MODEL, systemPrompt = "" }) => {
    try {
      const answer = await askDuck(prompt, { model, systemPrompt });
      return {
        content: [
          {
            type: "text",
            text: answer
          }
        ]
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Duck.ai error: ${err.message}`
          }
        ]
      };
    }
  }
);

// Start stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error starting MCP server:", error);
  process.exit(1);
});
