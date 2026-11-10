// Duck.ai (DuckChat) Engine via Local Browser CDP Bridge
//
// Architecture (verified end-to-end on hijilaptop):
//   1. Connect to the running Chrome instance over CDP (default 127.0.0.1:9222).
//   2. Reuse (or open) a duck.ai tab in that browser.
//   3. Inject a fetch hook inside the page context. The hook rewrites the
//      outgoing /duckchat/v1/chat body (model override) and tees the SSE
//      response into window.__duckaiBuffer so the Node side can read it.
//
// Why this works and plain DOM scraping does not:
//   - Duck.ai ships anti-bot protection (x-vqd-hash-1 challenge headers) that
//     are computed by the page itself. Driving the real browser means every
//     challenge, cookie, TLS fingerprint and session token is native.
//   - The SSE stream gives clean token deltas straight from the upstream API,
//     with no "Duck.ai said" headers, no citation buttons and no
//     "Generating response" placeholder to strip.
//
// Model override works by rewriting body.model before the request leaves the
// page, so any model Duck.ai exposes (gpt-6-luna, gpt-5.6-terra,
// claude-haiku-5-5, ...) can be selected without touching fragile dropdowns.

import http from "node:http";

const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";
const DUCK_URL = "https://duck.ai/";

const REQUEST_TIMEOUT_MS = Number(process.env.DUCK_TIMEOUT_MS || 120000);
const POLL_INTERVAL_MS = Number(process.env.DUCK_POLL_INTERVAL_MS || 120);

export const DUCK_SUPPORTED_MODELS = [
  { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai", verified: true },
  { id: "gpt-5.4-mini", name: "GPT-5.4 mini", provider: "openai", verified: true },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic", verified: true },
  { id: "mistral-small-2603", name: "Mistral Small 4", provider: "mistral", verified: true },
  { id: "tinfoil/gemma4-31b", name: "Gemma 4 31B", provider: "tinfoil", verified: true }
];

// Models advertised by the Duck.ai UI but that reject requests end-to-end
// (no SSE response within the timeout). They stay documented here so an
// upcoming Duck.ai rollout can be re-tested by re-running the model probe.
export const DUCK_UNVERIFIED_MODELS = [
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic" },
  { id: "tinfoil/gpt-oss-120b", name: "gpt-oss 120B", provider: "tinfoil" }
];

export const DEFAULT_DUCK_MODEL = "gpt-6-luna";

const DUCK_MODEL_IDS = new Set(DUCK_SUPPORTED_MODELS.map((m) => m.id));

export function isDuckModel(modelId) {
  if (!modelId) return false;
  const id = String(modelId).trim().toLowerCase();
  if (DUCK_MODEL_IDS.has(id)) return true;
  return (
    id.startsWith("duck") ||
    id.startsWith("gpt-5") ||
    id.startsWith("gpt-6") ||
    id.startsWith("claude-") ||
    id.startsWith("mistral") ||
    id.startsWith("tinfoil/")
  );
}

export function resolveDuckModel(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return DEFAULT_DUCK_MODEL;
  if (DUCK_MODEL_IDS.has(id)) return id;
  const lower = id.toLowerCase();
  if (lower === "claude-haiku-5-5" || lower === "claude-haiku-5.5") return "claude-haiku-5-5";
  if (lower === "gpt-5.6-terra" || lower === "gpt-56-terra") return "gpt-5.6-terra";
  if (lower === "gpt-6-luna" || lower === "gpt-6" || lower === "luna") return "gpt-6-luna";
  if (lower === "gpt-5.4-mini" || lower === "gpt-54-mini") return "gpt-5.4-mini";
  return id;
}

// ---------------------------------------------------------------------------
// Minimal CDP client
// ---------------------------------------------------------------------------

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.timers = new Set();
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        this.timers.delete(timer);
        if (msg.error) reject(new Error(msg.error.message || "CDP error"));
        else resolve(msg.result);
      }
    };
    this.ws.onclose = () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        this.timers.delete(timer);
        reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    };
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.timers.delete(timer);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, REQUEST_TIMEOUT_MS);
      this.timers.add(timer);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise
    });
    if (res.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        "evaluation failed";
      throw new Error(`Duck.ai page error: ${desc}`);
    }
    return res.result?.value;
  }

  close() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("CDP session closed"));
    }
    this.pending.clear();
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

function cdpHttpJson(pathname, { method = "GET", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(pathname, CDP_URL);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 9222,
        path: parsed.pathname + parsed.search,
        method,
        timeout: 8000,
        headers: body ? { "Content-Type": "application/json" } : {}
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : null);
            } catch {
              resolve(data);
            }
          } else {
            reject(new Error(`CDP HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("CDP request timeout")); });
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function listTabs() {
  const data = await cdpHttpJson("/json/list");
  if (!Array.isArray(data)) throw new Error("CDP list did not return an array");
  return data;
}

async function cdpAvailable() {
  try {
    const res = await cdpHttpJson("/json/version");
    return Boolean(res && res.Browser);
  } catch {
    return false;
  }
}

async function connectToTab(tab) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP websocket connect timeout")), 10000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(new Error(`CDP websocket error: ${err.message || "unknown"}`));
    };
  });
  return new CdpSession(ws);
}

/**
 * Find a usable duck.ai tab, creating or navigating one when needed.
 */
async function getOrCreateDuckTab({ freshPage = false } = {}) {
  const tabs = await listTabs();
  let tab = tabs.find((t) => t.type === "page" && t.url?.includes("duck.ai"));

  if (!tab) {
    try {
      tab = await cdpHttpJson(`/json/new?${encodeURIComponent(DUCK_URL)}`, { method: "PUT" });
    } catch {
      tab = await cdpHttpJson(`/json/new?${encodeURIComponent(DUCK_URL)}`, { method: "GET" });
    }
    if (!tab) {
      throw new Error(
        "Cannot open duck.ai tab. Is Chrome running with --remote-debugging-port=9222?"
      );
    }
    await new Promise((r) => setTimeout(r, 4000));
    return tab;
  }

  // A suspended extension tab or a non-duck.ai URL on that tab needs a reload.
  // freshPage forces a full reload so any foreign fetch hook (left over from
  // another session or tool) is wiped and our model override cannot be
  // overwritten by a stale wrapper.
  const needsNavigation =
    freshPage ||
    tab.url?.startsWith("chrome-extension://") ||
    tab.url?.startsWith("chrome://") ||
    !tab.url?.includes("duck.ai");

  if (needsNavigation) {
    const session = await connectToTab(tab);
    try {
      await session.send("Page.navigate", { url: DUCK_URL });
      await new Promise((r) => setTimeout(r, freshPage ? 5000 : 4000));
    } finally {
      session.close();
    }
  }

  return tab;
}

// ---------------------------------------------------------------------------
// Serialisation lock: one Duck.ai answer at a time
// ---------------------------------------------------------------------------

let duckLockTail = Promise.resolve();

/**
 * Wait for exclusive access to the Duck.ai tab.
 * @returns {Promise<() => void>} resolves with the release function
 */
function acquireDuckLock() {
  let release;
  const myTurn = new Promise((resolve) => {
    release = resolve;
  });
  const previous = duckLockTail;
  // The next caller waits on myTurn, which resolves only when we release.
  duckLockTail = previous.then(() => myTurn);
  return previous.then(() => release);
}

// ---------------------------------------------------------------------------
// Page-side hook: rewrite model, tee the SSE stream into a readable buffer
// ---------------------------------------------------------------------------

const HOOK_SCRIPT = `(() => {
  // Always rebuild the hook from the CURRENT window.fetch, but only once per
  // install. A stale hook from an earlier session must not be able to
  // overwrite the model we set, so we track our own generation marker.
  const GENERATION = "webai-gateway-v2";

  if (window.__duckaiHookGeneration === GENERATION) {
    // Our hook is already the live one: just reset the runtime state.
    window.__duckaiBuffer = [];
    window.__duckaiDone = false;
    window.__duckaiError = null;
    window.__duckaiModel = null;
    window.__duckaiSeq = 0;
    window.__duckaiStreams = {};
    return true;
  }

  // A previous or foreign hook is live. Unwrap it to reach the pristine fetch
  // when possible, otherwise wrap whatever is there.
  const baseFetch =
    window.__duckaiOriginalFetch && window.__duckaiOriginalFetch.__duckaiPristine
      ? window.__duckaiOriginalFetch
      : window.fetch;

  const pristine = baseFetch.bind(window);
  pristine.__duckaiPristine = true;

  window.__duckaiOriginalFetch = pristine;
  window.__duckaiHookGeneration = GENERATION;
  window.__duckaiHookInstalled = true;

  // Per-request streams live in a map keyed by a caller-supplied nonce, so two
  // concurrent callers (HTTP gateway + MCP server) never clobber each other.
  window.__duckaiStreams = {};

  window.__duckaiHookedFetch = async function (resource, init) {
    const url =
      typeof resource === "string"
        ? resource
        : resource && resource.url
          ? resource.url
          : "";

    const isDuckChat =
      url.includes("/duckchat/v1/chat") || url.includes("/duckchat/v1/completions");

    // The nonce rides along in a custom header so we can match the response
    // back to the caller that issued the request.
    const nonce =
      (init && init.headers && (init.headers["x-duckai-nonce"] || init.headers.get?.("x-duckai-nonce"))) ||
      window.__duckaiActiveNonce ||
      null;

    if (isDuckChat && init && typeof init.body === "string" && window.__duckaiModel) {
      try {
        const payload = JSON.parse(init.body);
        payload.model = window.__duckaiModel;
        init = { ...init, body: JSON.stringify(payload) };
      } catch (err) {
        console.error("[duckai-hook] body rewrite failed", err);
      }
    }

    const response = await window.__duckaiOriginalFetch(resource, init);

    if (isDuckChat) {
      const key = nonce || "default";
      try {
        const clone = response.clone();
        const reader = clone.body.getReader();
        const decoder = new TextDecoder();
        const stream = {
          chunks: [],
          done: false,
          error: null,
          status: response.status
        };
        window.__duckaiStreams[key] = stream;
        (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              stream.chunks.push(decoder.decode(value, { stream: true }));
            }
          } catch (err) {
            stream.error = String(err && err.message ? err.message : err);
          } finally {
            stream.done = true;
          }
        })();

        // A non-2xx response means the request was rejected (unknown model,
        // blocked region, expired challenge). Surface the upstream body so the
        // caller gets a real reason instead of a generic timeout.
        if (!response.ok) {
          clone.text()
            .then((body) => {
              stream.error = "HTTP " + response.status + ": " + String(body).slice(0, 400);
              stream.done = true;
            })
            .catch(() => {});
        }
      } catch (err) {
        const stream = window.__duckaiStreams[key] || {
          chunks: [],
          done: false,
          error: null,
          status: 0
        };
        stream.error = String(err && err.message ? err.message : err);
        stream.done = true;
        window.__duckaiStreams[key] = stream;
      }
    }

    return response;
  };

  window.fetch = window.__duckaiHookedFetch;

  window.__duckaiBuffer = [];
  window.__duckaiDone = false;
  window.__duckaiError = null;
  window.__duckaiModel = null;
  window.__duckaiSeq = 0;
  window.__duckaiStreams = {};

  return true;
})()`;

const RESET_SCRIPT = `(() => {
  window.__duckaiBuffer = [];
  window.__duckaiDone = false;
  window.__duckaiError = null;
  window.__duckaiSeq = (window.__duckaiSeq || 0) + 1;
  window.__duckaiStreams = {};
  return true;
})()`;

/**
 * Parse the raw SSE payload Duck.ai returns.
 * Lines look like: data: {"id":"...","action":"success","model":"gpt-6-luna","role":"assistant","message":"Ap"}
 * terminated by: data: [DONE]
 */
function parseSseChunk(raw) {
  const events = [];
  const lines = raw.split(/\r?\n/);
  let remainder = "";
  if (!raw.endsWith("\n")) {
    remainder = lines.pop() || "";
  }

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      events.push({ type: "done" });
      continue;
    }
    try {
      const obj = JSON.parse(payload);
      if (typeof obj.message === "string") {
        events.push({ type: "text", text: obj.message, model: obj.model || null });
      } else if (obj.role === "assistant" && typeof obj.content === "string") {
        events.push({ type: "text", text: obj.content, model: obj.model || null });
      } else if (obj.error) {
        events.push({ type: "error", message: String(obj.message || obj.error) });
      }
    } catch {
      // Ignore partial JSON or keep-alives
    }
  }
  return { events, remainder };
}

/**
 * Streaming sanitizer for Duck.ai inline citation markers.
 *
 * Duck.ai emits citations as <citation src="1"></citation> but the marker can be
 * split across two SSE chunks, so a per-chunk regex would leak raw tags into
 * the output. This class holds the pending partial marker across chunks and
 * only emits text that is known to be free of citation markup.
 */
class CitationSanitizer {
  constructor() {
    this.pending = "";
  }

  /**
   * @param {string} text Raw text chunk
   * @returns {string} Text safe to emit (may be empty)
   */
  push(text) {
    const combined = this.pending + text;
    this.pending = "";

    const OPEN = "<citation";
    const CLOSE = "</citation>";

    let out = "";
    let idx = 0;

    while (idx < combined.length) {
      const openAt = combined.indexOf(OPEN, idx);
      if (openAt === -1) {
        // The tag arrives token-by-token (" <", "citation", " src", ...), so a
        // trailing partial prefix of OPEN ("<", "<c", "<ci", ...) must be held
        // back until the next chunk confirms or refutes it.
        let safeEnd = combined.length;
        const maxLen = Math.min(OPEN.length - 1, combined.length - idx);
        for (let len = maxLen; len > 0; len--) {
          if (combined.endsWith(OPEN.slice(0, len))) {
            this.pending = combined.slice(combined.length - len);
            safeEnd = combined.length - len;
            break;
          }
        }
        out += combined.slice(idx, safeEnd);
        break;
      }

      out += combined.slice(idx, openAt);

      const closeAt = combined.indexOf(CLOSE, openAt);
      if (closeAt === -1) {
        // Marker may continue in the next chunk: hold it back.
        this.pending = combined.slice(openAt);
        break;
      }

      // Skip the whole citation block.
      idx = closeAt + CLOSE.length;
    }

    return out;
  }

  /**
   * Flush any held-back text at end of stream.
   */
  flush() {
    const rest = this.pending;
    this.pending = "";
    // A dangling opening marker (full or partial) is dropped; other text is
    // kept. A partial prefix like "<" or "<c" means the tag was truncated by
    // the stream ending, so emitting it would leak raw markup.
    if (!rest) return "";
    if (rest.startsWith("<citation")) return "";
    if ("<citation".startsWith(rest)) return "";
    return rest;
  }
}

/**
 * Compose the conversation payload Duck.ai expects.
 * Duck.ai accepts a full message history, which lets us support multi-turn
 * conversations and a system prompt without touching the UI.
 */
export function buildDuckMessages(conversation) {
  const messages = [];
  for (const msg of conversation || []) {
    const role = msg.role || "user";
    const text = typeof msg.content === "string" ? msg.content : "";
    if (!text) continue;
    if (role === "system") continue;
    messages.push({
      role: role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text }]
    });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stream a chat completion from Duck.ai.
 *
 * @param {string} prompt            User prompt
 * @param {object} options
 * @param {string} options.model     Duck model id (default gpt-6-luna)
 * @param {string} options.systemPrompt
 * @param {Array}  options.messages  Full OpenAI-style message history
 * @param {number} options.timeoutMs
 * @param {boolean} options.newChat   Start a fresh Duck.ai chat first
 */
export async function* askDuckStream(prompt, options = {}) {
  const model = resolveDuckModel(options.model || DEFAULT_DUCK_MODEL);
  const timeoutMs = Number(options.timeoutMs || REQUEST_TIMEOUT_MS);

  // Duck.ai runs in a single browser tab and can only stream one answer at a
  // time. Two concurrent callers would fight over the composer, the Send
  // button and the response stream, so requests are serialised here. The
  // second caller waits its turn instead of corrupting the first one.
  const release = await acquireDuckLock();

  try {
    yield* runDuckStream(prompt, options, model, timeoutMs);
  } finally {
    release();
  }
}

async function* runDuckStream(prompt, options, model, timeoutMs) {
  if (!(await cdpAvailable())) {
    throw new Error(
      "Duck.ai bridge unavailable: Chrome CDP endpoint " +
        CDP_URL +
        " is not reachable. Start Chrome with --remote-debugging-port=9222."
    );
  }

  // A fresh page guarantees no foreign fetch hook can override our model.
  const freshPage = options.freshPage !== false;
  const tab = await getOrCreateDuckTab({ freshPage });
  if (!tab?.webSocketDebuggerUrl) {
    throw new Error("Duck.ai bridge unavailable: no CDP tab for duck.ai");
  }

  const session = await connectToTab(tab);

  // A nonce identifies this caller's stream so concurrent callers (HTTP
  // gateway + MCP server) never clobber each other's response buffer.
  const nonce = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  try {
    // 1. Install the hook on a clean page and reset the runtime state.
    await session.evaluate(HOOK_SCRIPT);
    await session.evaluate(RESET_SCRIPT);
    await session.evaluate(
      `(() => { window.__duckaiModel = ${JSON.stringify(model)}; return true; })()`
    );

    // 2. Optionally start a fresh chat so long running sessions stay snappy.
    //    Duck.ai renders the "New Chat" control as a text button (with a CTRL
    //    shortcut hint), not with an aria-label, so match on visible text.
    if (options.newChat) {
      const clicked = await session.evaluate(`(() => {
        const btn = Array.from(document.querySelectorAll("button")).find(
          (b) => /^New Chat/i.test((b.innerText || "").trim()) && b.offsetParent !== null
        );
        if (btn) { btn.click(); return true; }
        return false;
      })()`);
      if (clicked) {
        await new Promise((r) => setTimeout(r, 1500));
      }
      // Clicking "New Chat" can re-render the app, so re-assert the hook and
      // the model override afterwards.
      await session.evaluate(HOOK_SCRIPT);
      await session.evaluate(RESET_SCRIPT);
      await session.evaluate(
        `(() => { window.__duckaiModel = ${JSON.stringify(model)}; return true; })()`
      );
    }

    // 3. Fill the composer and submit.
    const history =
      Array.isArray(options.messages) && options.messages.length > 0
        ? options.messages
        : [{ role: "user", content: prompt }];

    const finalUserTurn = history[history.length - 1];
    const finalPrompt =
      typeof finalUserTurn?.content === "string" ? finalUserTurn.content : prompt;

    await session.evaluate(
      `(() => { window.__duckaiActiveNonce = ${JSON.stringify(nonce)}; return true; })()`
    );

    await session.evaluate(`(() => {
      const ta = document.querySelector("textarea");
      if (!ta) return false;
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(ta, ${JSON.stringify(finalPrompt)});
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);

    await new Promise((r) => setTimeout(r, 250));

    // The Send button may not be wired up yet right after a page reload or a
    // New Chat transition; poll for it briefly before giving up.
    let submitted = false;
    const submitDeadline = Date.now() + 10000;
    while (Date.now() < submitDeadline) {
      submitted = await session.evaluate(`(() => {
        const ta = document.querySelector("textarea");
        const btn = document.querySelector("button[aria-label='Send']");
        if (ta && btn && !btn.disabled && ta.value) {
          btn.click();
          return true;
        }
        if (ta && !ta.value) {
          // Composer lost its text (re-render): refill it.
          ta.focus();
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            "value"
          ).set;
          setter.call(ta, ${JSON.stringify(finalPrompt)});
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return false;
      })()`);
      if (submitted) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    if (!submitted) {
      throw new Error("Duck.ai: send button unavailable (composer empty or blocked)");
    }

    // 4. Drain the SSE buffer until Duck.ai signals [DONE].
    const deadline = Date.now() + timeoutMs;
    const sanitizer = new CitationSanitizer();
    let buffer = "";
    let emitted = 0;
    let sawDone = false;
    let pageError = null;
    let upstreamStatus = 0;
    let emptyUpstream = false;

    // Tag the next Duck.ai request with our nonce so the hook can route the
    // response stream back to this caller even when others run concurrently.
    await session.evaluate(
      `(() => { window.__duckaiActiveNonce = ${JSON.stringify(nonce)}; return true; })()`
    );

    while (Date.now() < deadline) {
      // Atomic drain: read and clear the page buffer in a single evaluate call
      // so no chunk can be lost between the read and the clear.
      const drained = await session.evaluate(`(() => {
        const streams = window.__duckaiStreams || {};
        const stream = streams[${JSON.stringify(nonce)}] || streams.default || null;
        const chunks = stream
          ? stream.chunks.slice()
          : (window.__duckaiBuffer ? window.__duckaiBuffer.slice() : []);
        if (stream) {
          stream.chunks = [];
        } else {
          window.__duckaiBuffer = [];
        }
        return {
          chunks,
          done: stream ? !!stream.done : !!window.__duckaiDone,
          error: (stream && stream.error) || window.__duckaiError || null,
          status: (stream && stream.status) || 0
        };
      })()`);

      const state = drained || { chunks: [], done: false, error: null, status: 0 };
      pageError = state.error;
      if (state.status) upstreamStatus = state.status;

      for (const chunk of state.chunks) {
        buffer += chunk;
      }

      const { events, remainder } = parseSseChunk(buffer);
      buffer = remainder;

      for (const event of events) {
        if (event.type === "done") {
          sawDone = true;
          continue;
        }
        if (event.type === "error") {
          throw new Error(`Duck.ai upstream error: ${event.message}`);
        }
        if (event.type === "text") {
          const clean = sanitizer.push(event.text);
          if (clean.length > 0) {
            emitted += clean.length;
            yield clean;
          }
        }
      }

      if (sawDone) {
        const tail = sanitizer.flush();
        if (tail.length > 0) {
          emitted += tail.length;
          yield tail;
        }
        break;
      }

      // An upstream rejection carries a real reason; surface it now instead of
      // waiting for the timeout.
      if (pageError && upstreamStatus && upstreamStatus >= 400) {
        throw new Error(`Duck.ai upstream rejected the request: ${pageError}`);
      }

      if (state.done && !state.chunks.length) {
        // Stream finished but no [DONE] seen: flush whatever is left.
        const tail = parseSseChunk(buffer + "\n");
        buffer = "";
        for (const event of tail.events) {
          if (event.type === "text") {
            const clean = sanitizer.push(event.text);
            if (clean.length > 0) {
              emitted += clean.length;
              yield clean;
            }
          }
        }
        const rest = sanitizer.flush();
        if (rest.length > 0) {
          emitted += rest.length;
          yield rest;
        }
        emptyUpstream = emitted === 0;
        break;
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (!sawDone && emitted === 0) {
      if (pageError) {
        throw new Error(`Duck.ai stream error: ${pageError}`);
      }
      if (upstreamStatus && upstreamStatus >= 400) {
        throw new Error(
          `Duck.ai upstream rejected the request (HTTP ${upstreamStatus})`
        );
      }
      if (emptyUpstream) {
        throw new Error(
          "Duck.ai accepted the request but returned an empty stream " +
            "(HTTP 200, no SSE frames). The selected model may be unavailable " +
            "for this account."
        );
      }
      throw new Error(
        "Duck.ai generation timeout (" +
          Math.round(timeoutMs / 1000) +
          "s) before any response was received"
      );
    }
  } finally {
    session.close();
  }
}

/**
 * Non-streaming convenience wrapper around {@link askDuckStream}.
 */
export async function askDuck(prompt, options = {}) {
  let fullText = "";
  for await (const chunk of askDuckStream(prompt, options)) {
    fullText += chunk;
  }
  return fullText;
}

/**
 * Health probe: is the Duck.ai bridge usable right now?
 */
export async function duckHealth() {
  const available = await cdpAvailable();
  if (!available) {
    return { ok: false, reason: `CDP ${CDP_URL} unreachable` };
  }
  try {
    const tabs = await listTabs();
    const tab = tabs.find((t) => t.type === "page" && t.url?.includes("duck.ai"));
    return {
      ok: Boolean(tab),
      reason: tab ? "duck.ai tab attached" : "no duck.ai tab open",
      cdpUrl: CDP_URL,
      models: DUCK_SUPPORTED_MODELS.map((m) => m.id)
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
