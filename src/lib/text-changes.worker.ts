import { compareTexts } from "../../shared/text-changes";

self.onmessage = (event: MessageEvent<{ original: string; edited: string }>) => {
  try { self.postMessage(compareTexts(event.data.original, event.data.edited)); }
  catch { self.postMessage({ ok: false, reason: "failed" }); }
};
