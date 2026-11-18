import { APIConnectionError, ServerError, errorFor } from "./errors.js";

export interface HttpConfig { baseUrl: string; key: string; maxRetries: number; retryDelay: number; fetch: typeof fetch }

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function once(config: HttpConfig, init: { method: "GET" | "POST"; path: string; query?: Record<string, string>; body?: unknown }) {
  const url = new URL(config.baseUrl + init.path);
  for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);
  const headers: Record<string, string> = { authorization: `Bearer ${config.key}` };
  if (init.method === "POST") headers["content-type"] = "application/json";
  let res: Response;
  let text: string;
  try {
    res = await config.fetch(url, { method: init.method, headers, body: init.method === "POST" ? JSON.stringify(init.body) : undefined });
    text = await res.text();
  } catch {
    // The cause can echo the request, so it is not chained.
    throw new APIConnectionError(`Could not reach the MausBot server at ${url.origin}`);
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = undefined; }
  if (res.status >= 400) throw errorFor(res.status, body, res.headers);
  return { status: res.status, body };
}

/** One call. A GET is retried on a network error or a 5xx; a POST never is, since a retry could start a second turn. */
export async function request(
  config: HttpConfig,
  init: { method: "GET" | "POST"; path: string; query?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await once(config, init);
    } catch (error) {
      const retryable = error instanceof APIConnectionError || error instanceof ServerError;
      if (init.method !== "GET" || !retryable || attempt >= config.maxRetries) throw error;
      await sleep(config.retryDelay * 2 ** attempt);
    }
  }
}
