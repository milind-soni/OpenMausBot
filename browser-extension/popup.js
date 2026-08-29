const SOURCE_HOSTS = {
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

const status = document.getElementById("status");
const approval = document.getElementById("approval");
const capture = document.getElementById("capture");

function sourceForUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  for (const [suffix, source] of Object.entries(SOURCE_HOSTS)) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return source;
  }
  return null;
}

const approvalKey = (tabId) => `approved-tab:${tabId}`;

async function activeSupportedTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const sourceId = tab?.url ? sourceForUrl(tab.url) : null;
  if (!tab?.id || !sourceId) throw new Error("Open a supported HTTPS source first");
  return { tab, sourceId };
}

async function refresh() {
  try {
    const { tab, sourceId } = await activeSupportedTab();
    const approved = (await chrome.storage.local.get(approvalKey(tab.id)))[approvalKey(tab.id)];
    const active = approved?.sourceId === sourceId;
    approval.textContent = active ? "Stop automatic capture for this tab" : "Approve this tab";
    capture.disabled = !active;
    status.textContent = active ? `${sourceId} is approved.` : `${sourceId} is not approved.`;
  } catch (error) {
    approval.disabled = true;
    capture.disabled = true;
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

approval.addEventListener("click", async () => {
  approval.disabled = true;
  try {
    const { tab, sourceId } = await activeSupportedTab();
    const key = approvalKey(tab.id);
    const approved = (await chrome.storage.local.get(key))[key];
    if (approved?.sourceId === sourceId) {
      await chrome.storage.local.remove(key);
      status.textContent = "Automatic capture stopped for this tab.";
    } else {
      await chrome.storage.local.set({ [key]: { sourceId, approvedAt: new Date().toISOString() } });
      const result = await chrome.runtime.sendMessage({ type: "capture-tab", tabId: tab.id });
      status.textContent = result?.status === "captured"
        ? `Approved and seeded ${sourceId}.`
        : `Approved ${sourceId}; seed status: ${result?.status ?? "unknown"}.`;
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    approval.disabled = false;
    await refresh();
  }
});

capture.addEventListener("click", async () => {
  capture.disabled = true;
  status.textContent = "Reading approved tab…";
  try {
    const { tab } = await activeSupportedTab();
    const result = await chrome.runtime.sendMessage({ type: "capture-tab", tabId: tab.id });
    status.textContent = result?.status === "captured"
      ? `Sent ${result.sourceId} to OpenMausBot.`
      : `Capture status: ${result?.status ?? "unknown"}.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    await refresh();
  }
});

void refresh();
