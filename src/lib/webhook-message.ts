export interface WebhookMessageView {
  task: string;
  payload?: string;
  /** The connected app that handed the task over, from the trusted note the server writes first. */
  app?: string;
}

/** A view only: the stored model-safe prompt stays untouched, preserving the trust boundary. */
export function webhookMessageView(text: string): WebhookMessageView | null {
  const eventStart = text.indexOf("[UNTRUSTED WEBHOOK EVENT DATA]\n");
  if (eventStart < 0) return null;
  const trustedPrefix = text.slice(0, eventStart);
  const markers = [
    "AUTHENTICATED WEBHOOK TASK",
    "USER-CONFIGURED WEBHOOK INSTRUCTIONS",
    "DEFAULT WEBHOOK INSTRUCTIONS",
  ];
  let task = "";
  for (const marker of markers) {
    const match = trustedPrefix.match(new RegExp(`\\[${marker}\\]\\n([\\s\\S]*?)\\n\\[\\/${marker}\\]`));
    const candidate = match?.[1]?.trim();
    if (candidate) {
      task = candidate;
      break;
    }
  }

  const eventData = text.match(/\[UNTRUSTED WEBHOOK EVENT DATA\]\n([\s\S]*?)\n\[\/UNTRUSTED WEBHOOK EVENT DATA\]/)?.[1];
  if (!task || !eventData) return null;

  const splitAt = eventData.indexOf("\n\n");
  const payload = (splitAt >= 0 ? eventData.slice(splitAt + 2) : "").trim();
  const app = trustedPrefix.match(/^\[From (.+?), an app the person connected · /)?.[1];
  return { task, payload: payload || undefined, ...(app ? { app } : {}) };
}
