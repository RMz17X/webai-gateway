import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Browser, BrowserPlatform, detectBrowserPlatform, install, resolveBuildId } from "@puppeteer/browsers";

const CDP_PORT = process.env.CDP_PORT || 9222;
const CDP_URL = process.env.CDP_URL || `http://127.0.0.1:${CDP_PORT}`;
const PROFILE_DIR = path.join(os.homedir(), ".cache", "webai-gateway", "browser-profile");
const BINARIES_DIR = path.join(os.homedir(), ".cache", "webai-gateway", "binaries");

let managedBrowserProcess = null;

/**
 * Check if a CDP endpoint is already alive.
 */
export async function isCdpAlive(url = CDP_URL) {
  try {
    const res = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data && data.Browser);
  } catch {
    return false;
  }
}

/**
 * Find locally installed Chrome, Chromium, or Brave binaries.
 */
export function findSystemBrowser() {
  const customPath = process.env.CHROME_PATH || process.env.BROWSER_PATH;
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  const candidates = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/brave-origin-bin/brave",
    "/usr/bin/brave-browser",
    "/usr/bin/brave",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Download a standalone Chromium build if no system browser is found.
 */
export async function ensureBrowserBinary() {
  const systemBrowser = findSystemBrowser();
  if (systemBrowser) {
    return systemBrowser;
  }

  fs.mkdirSync(BINARIES_DIR, { recursive: true });
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error("Unsupported OS platform for auto-downloading browser binary");
  }

  console.log("[webai-gateway] No system browser found. Auto-downloading Chrome build via @puppeteer/browsers...");
  const buildId = await resolveBuildId(Browser.CHROME, platform, "stable");
  const installed = await install({
    browser: Browser.CHROME,
    buildId,
    cacheDir: BINARIES_DIR,
    platform
  });

  console.log(`[webai-gateway] Browser downloaded successfully: ${installed.executablePath}`);
  return installed.executablePath;
}

/**
 * Ensure browser with remote debugging port is up and running.
 */
export async function ensureBrowser() {
  if (await isCdpAlive(CDP_URL)) {
    return { cdpUrl: CDP_URL, managed: false };
  }

  const executablePath = await ensureBrowserBinary();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--disable-features=IsolateOrigins,site-per-process",
    "--no-sandbox",
    "https://duck.ai/"
  ];

  // Headless check: if no DISPLAY and not on Windows/Mac, fallback or warn
  if (process.platform === "linux" && !process.env.DISPLAY) {
    console.warn("[webai-gateway] No DISPLAY found. For optimal anti-bot pass rates, run under Xvfb (e.g. xvfb-run node src/server.js).");
    // Still try with standard flags
  }

  console.log(`[webai-gateway] Spawning managed browser: ${executablePath} on port ${CDP_PORT}...`);
  managedBrowserProcess = spawn(executablePath, args, {
    detached: true,
    stdio: "ignore"
  });

  managedBrowserProcess.unref();

  // Poll until CDP is responsive
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await isCdpAlive(CDP_URL)) {
      console.log(`[webai-gateway] Managed browser is live on ${CDP_URL}`);
      return { cdpUrl: CDP_URL, managed: true };
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  throw new Error(`Failed to connect to browser CDP at ${CDP_URL} after launching ${executablePath}`);
}
