// The agents tools' only way to the harness: loopback /api/internal/* with this turn's capability token;
// the harness authenticates and scopes every call.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type Json = Record<string, unknown>;

export type HarnessRequest = { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal };

export interface HarnessClient {
  /** The route's JSON body; a refusal throws an Error carrying the route's `error` sentence. */
  api(path: string, init?: HarnessRequest): Promise<Json>;
  /** Like api, but a refusal comes back as its body. */
  apiResponse(path: string, init?: HarnessRequest): Promise<{ ok: boolean; status: number; body: Json }>;
}

/** Node's fetch (undici 7.29 in Electron 43) fails a call after 300 s without response headers, whatever its signal
 * allows; node:http waits as long as the harness works, such as a lent computer's command of up to 900 s. */
function send(url: URL, init: HarnessRequest): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: init.method ?? "GET", headers: init.headers, signal: init.signal }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(init.body);
  });
}

export function createHarnessClient(baseUrl: string, token: string): HarnessClient {
  async function api(path: string, init?: HarnessRequest): Promise<Json> {
    const { ok, status, body } = await apiResponse(path, init);
    if (!ok) throw new Error(String(body.error ?? `HTTP ${status}`));
    return body;
  }

  async function apiResponse(path: string, init: HarnessRequest = {}): Promise<{ ok: boolean; status: number; body: Json }> {
    const { status, text } = await send(new URL(baseUrl + path), {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
    });
    let body: Json = {};
    try { body = JSON.parse(text) as Json; } catch {}
    return { ok: status >= 200 && status < 300, status, body };
  }

  return { api, apiResponse };
}

/** The client a spawned proxy was given:
 *   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
 *   OMB_COMMS_TOKEN  the capability token for the internal endpoints */
export function harnessClientFromEnv(env: NodeJS.ProcessEnv): HarnessClient {
  return createHarnessClient(env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799", env.OMB_COMMS_TOKEN ?? "");
}
