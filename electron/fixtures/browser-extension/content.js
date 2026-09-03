// Two markers, both in the DOM because a content script's `window` lives in
// an isolated world the main process cannot read:
//   ombExtension  — the content script ran at all
//   probeFetch    — a chrome-extension:// subresource got through the
//                   session's request policy
const el = document.documentElement;
el.dataset.ombExtension = "1";
el.dataset.probeFetch = "pending";
fetch(chrome.runtime.getURL("probe.json"))
  .then((r) => r.json())
  .then((j) => { el.dataset.probeFetch = "ok:" + j.webAccessibleResource; })
  .catch((e) => { el.dataset.probeFetch = "failed:" + String((e && e.message) || e); });
