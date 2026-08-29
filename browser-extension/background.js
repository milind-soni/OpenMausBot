const ALARM = "capture-approved-tabs";
export const browserCaptureEndpoint = "http://127.0.0.1:8799/api/browser-capture/receipt";
const URL_PATTERNS = [
  "https://messages.google.com/*",
  "https://plaud.ai/*",
  "https://*.plaud.ai/*",
  "https://monarchmoney.com/*",
  "https://*.monarchmoney.com/*",
  "https://app.monarch.com/*",
  "https://youtube.com/*",
  "https://*.youtube.com/*",
  "https://youtu.be/*",
  "https://mercury.com/*",
  "https://*.mercury.com/*",
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://claude.ai/*",
  "https://*.claude.ai/*",
  "https://grok.com/*",
  "https://*.grok.com/*",
  "https://gemini.google.com/*",
];

export function sourceForUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const map = {
    "messages.google.com": "google-messages",
    "monarchmoney.com": "monarch",
    "app.monarch.com": "monarch",
    "plaud.ai": "plaud",
    "youtube.com": "youtube",
    "youtu.be": "youtube",
    "mercury.com": "mercury",
    "chatgpt.com": "ai-chatgpt",
    "chat.openai.com": "ai-chatgpt",
    "claude.ai": "ai-claude",
    "grok.com": "ai-grok",
    "gemini.google.com": "ai-gemini",
  };
  for (const [suffix, source] of Object.entries(map)) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return source;
  }
  return null;
}

export const approvalKey = (tabId) => `approved-tab:${tabId}`;
const fingerprintKey = (tabId) => `fingerprint:${tabId}`;

/** This function is serialized into the page, so it deliberately has no outer dependencies. */
function collectApprovedPage() {
  const sourceForHost = (host) => {
    const map = {
      "messages.google.com": "google-messages",
      "monarchmoney.com": "monarch",
      "app.monarch.com": "monarch",
      "plaud.ai": "plaud",
      "youtube.com": "youtube",
      "youtu.be": "youtube",
      "mercury.com": "mercury",
      "chatgpt.com": "ai-chatgpt",
      "chat.openai.com": "ai-chatgpt",
      "claude.ai": "ai-claude",
      "grok.com": "ai-grok",
      "gemini.google.com": "ai-gemini",
    };
    for (const [suffix, source] of Object.entries(map)) {
      if (host === suffix || host.endsWith(`.${suffix}`)) return source;
    }
    return null;
  };
  const redact = (value) => value
    .replace(/\b(?:otp|one[- ]?time password|verification code|security code)\s*[:=-]?\s*\d{4,10}\b/gi, "[redacted]")
    .replace(/\b(?:password|passcode|api[ _-]?key|access token|bearer)\s*[:=-]\s*\S+/gi, "[redacted]")
    .replace(/\b(?:sk|xai|ak|ghp|gho|eyJ)[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
  const hash = (value) => {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(16).padStart(8, "0");
  };
  const visibleTextWithoutEditors = () => {
    const root = document.querySelector("main, [role='main']") || document.body;
    if (!root) return "";
    const clone = root.cloneNode(true);
    clone.querySelectorAll([
      "input", "textarea", "select", "option", "button", "form",
      "[contenteditable]", "[role='textbox']", "[aria-multiline='true']",
      "script", "style", "noscript", "svg",
    ].join(",")).forEach((node) => node.remove());
    return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
  };
  const aiPortalThreadTitles = (sourceId) => {
    const selectors = "nav a[href], aside a[href], [role='navigation'] a[href]";
    const generic = /^(new (chat|project)|search|settings|help|upgrade|home|discover|library|chats?|projects?|recents?|show more|collapse|expand)$/i;
    const unique = new Set();
    for (const node of document.querySelectorAll(selectors)) {
      if (node.closest("form, [contenteditable], [role='textbox']")) continue;
      const title = redact((node.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 240);
      if (title.length < 2 || generic.test(title)) continue;
      unique.add(title);
      if (unique.size >= 50) break;
    }
    return [...unique];
  };
  const youtubeHistoryTitles = () => {
    const unique = new Set();
    const selectors = [
      "ytd-video-renderer a#video-title",
      "ytd-rich-item-renderer a#video-title-link",
      "ytd-grid-video-renderer a#video-title",
      "main a#video-title",
    ].join(",");
    for (const node of document.querySelectorAll(selectors)) {
      const candidate = node.getAttribute("title") || node.getAttribute("aria-label") || node.textContent || "";
      const title = redact(candidate.replace(/\s+/g, " ").trim()).slice(0, 240);
      if (title.length < 2) continue;
      unique.add(title);
      if (unique.size >= 50) break;
    }
    return [...unique];
  };

  const sourceId = sourceForHost(location.hostname.toLowerCase());
  if (!sourceId || location.protocol !== "https:") return null;
  const isAiPortal = sourceId.startsWith("ai-");
  const isYouTubeWatch = sourceId === "youtube" && (location.hostname === "youtu.be" || location.pathname.startsWith("/watch"));
  const isYouTubeHistory = sourceId === "youtube" && location.pathname.startsWith("/feed/history");
  if (sourceId === "youtube" && !isYouTubeWatch && !isYouTubeHistory) {
    return { skipped: true, reason: "Open a YouTube watch or watch-history page" };
  }
  const raw = isAiPortal ? "" : visibleTextWithoutEditors();
  const title = redact((document.title || location.hostname).replace(/\s+/g, " ").trim()).slice(0, 240);
  const loginProbe = isAiPortal ? (document.body?.innerText || "").slice(0, 2_000) : raw.slice(0, 2_000);
  const loginWall = /\b(sign in|log in|pair your phone|scan (?:the )?qr|use messages on your computer)\b/i.test(loginProbe);
  if (sourceId !== "youtube" && loginWall && raw.length < 3_000) {
    return { sourceId, needsAuth: true, title };
  }
  const url = new URL(location.href);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const text = sourceId === "youtube" ? "" : redact(raw).slice(0, 4_000);
  const aiItems = isAiPortal
    ? aiPortalThreadTitles(sourceId).map((threadTitle) => ({ kind: "record", title: threadTitle }))
    : null;
  const youtubeItems = isYouTubeHistory
    ? youtubeHistoryTitles().map((videoTitle) => ({ kind: "video", title: videoTitle }))
    : null;
  const structuredItems = aiItems ?? youtubeItems;
  const itemTitle = isYouTubeWatch
    ? redact(document.querySelector("h1.ytd-watch-metadata, h1.title")?.textContent?.trim() || title).slice(0, 240)
    : title;
  return {
    sourceId,
    needsAuth: false,
    title,
    url: url.toString(),
    text,
    itemTitle,
    items: structuredItems,
    fingerprint: hash(`${url.toString()}\n${title}\n${text}\n${structuredItems?.map((item) => item.title).join("\n") ?? ""}`),
  };
}

export async function submitReceipt(receipt, fetchImpl = fetch) {
  const response = await fetchImpl(browserCaptureEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openmausbot-capture": "1",
    },
    body: JSON.stringify(receipt),
  });
  if (!response.ok) throw new Error(`OpenMausBot rejected the receipt (${response.status})`);
}

async function approvedSourceForTab(tab) {
  if (!tab.id || !tab.url) return null;
  const sourceId = sourceForUrl(tab.url);
  if (!sourceId) return null;
  const approved = (await chrome.storage.local.get(approvalKey(tab.id)))[approvalKey(tab.id)];
  return approved?.sourceId === sourceId ? sourceId : null;
}

async function captureTab(tab) {
  if (!tab.id || !(await approvedSourceForTab(tab))) return { status: "not-approved" };
  let result;
  try {
    const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectApprovedPage });
    result = injected[0]?.result;
  } catch {
    return { status: "unavailable" };
  }
  if (!result) return { status: "unsupported" };
  if (result.skipped) return { status: "skipped", reason: result.reason };
  if (result.needsAuth) return { status: "needs-auth", sourceId: result.sourceId };

  const key = fingerprintKey(tab.id);
  const prior = (await chrome.storage.local.get(key))[key];
  const changed = prior !== result.fingerprint;
  const capturedAt = new Date().toISOString();
  const captureId = crypto.randomUUID();
  const kind = result.sourceId === "google-messages"
    ? "message"
    : result.sourceId === "plaud"
      ? "transcript"
      : result.sourceId === "youtube"
        ? "video"
        : "record";
  const item = { kind, title: result.itemTitle };
  if (result.text) item.text = result.text;
  const items = Array.isArray(result.items) ? result.items.slice(0, 50) : [item];
  const receipt = {
    schemaVersion: 1,
    captureId,
    capturedAt,
    sourceId: result.sourceId,
    url: result.url,
    title: result.title,
    items: changed ? items : [],
    cursor: { capturedAt, captureId },
  };
  try {
    await submitReceipt(receipt);
  } catch {
    // Do not advance the fingerprint. The next manual or scheduled sweep
    // retries the same changed content after OpenMausBot becomes available.
    return { status: "bridge-unavailable", sourceId: result.sourceId };
  }
  await chrome.storage.local.set({ [key]: result.fingerprint, [`observed:${result.sourceId}:${tab.id}`]: capturedAt });
  return { status: "captured", sourceId: result.sourceId, changed };
}

async function captureAll() {
  const tabs = await chrome.tabs.query({ url: URL_PATTERNS });
  for (const tab of tabs) await captureTab(tab);
}

async function installAlarm() {
  await chrome.alarms.create(ALARM, { delayInMinutes: 0.1, periodInMinutes: 5 });
  await captureAll();
}

if (typeof chrome !== "undefined") {
  chrome.runtime.onInstalled.addListener(() => { void installAlarm(); });
  chrome.runtime.onStartup.addListener(() => { void installAlarm(); });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void captureAll();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void chrome.storage.local.remove([approvalKey(tabId), fingerprintKey(tabId)]);
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "capture-tab" || !Number.isInteger(message.tabId)) return false;
    void chrome.tabs.get(message.tabId)
      .then(captureTab)
      .then(sendResponse)
      .catch(() => sendResponse({ status: "unavailable" }));
    return true;
  });
}
