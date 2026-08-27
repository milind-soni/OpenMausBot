import type { DingTalkHttpResult, DingTalkSessionSendPort } from "./ports.ts";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function assertDingTalkWebhook(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "dingtalk.com" && !url.hostname.endsWith(".dingtalk.com"))) {
    throw new Error("dingtalk_session_webhook_invalid");
  }
  return url;
}

/** Sends only to the ephemeral webhook supplied by DingTalk. The URL is never retained or logged here. */
export class FetchDingTalkSessionSender implements DingTalkSessionSendPort {
  private readonly fetcher: FetchLike;

  constructor(fetcher: FetchLike = fetch) {
    this.fetcher = fetcher;
  }

  async send(webhookUrl: string, payload: unknown): Promise<DingTalkHttpResult> {
    const url = assertDingTalkWebhook(webhookUrl);
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
    });
    return { ok: response.ok, status: response.status, ...(!response.ok ? { code: `http_${response.status}` } : {}) };
  }
}
