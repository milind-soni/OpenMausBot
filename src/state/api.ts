// The renderer's JSON request helper. A Cloud home that went to sleep is never woken by a background poll
// (src/lib/cloud-power.ts).
import { asleepAnswer, BACKGROUND_HEADER, cloudAsleep, markCloudAsleep, markCloudAwake } from "../lib/cloud-power";
import { serverErrorText } from "../lib/server-error";

export class ApiError extends Error {
  readonly status: number;
  readonly body?: Record<string, unknown>;
  constructor(message: string, status: number, body?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** `background`: a poll nobody asked for just now. It never wakes a Cloud home that went to sleep (it is refused here
 * instead, src/lib/cloud-power.ts) and the home doesn't count it as someone using it. Anything else wakes it. */
export async function api<T = any>(path: string, init?: RequestInit & { timeoutMs?: number; background?: boolean }): Promise<T> {
  const { timeoutMs, signal, background, headers, ...rest } = init ?? {};
  if (cloudAsleep()) {
    if (background) throw new ApiError("My Cloud is asleep", 503, { error: "asleep" });
    markCloudAwake();
  }
  const sent = new Headers(headers ?? { "content-type": "application/json" });
  if (background) sent.set(BACKGROUND_HEADER, "1");
  const res = await fetch(path, {
    ...rest,
    headers: sent,
    signal: timeoutMs === undefined
      ? signal
      : signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
  });
  if (asleepAnswer(res)) markCloudAsleep();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = body?.error;
    const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : `${res.status} ${res.statusText}`;
    throw new ApiError(serverErrorText(body, message), res.status, body);
  }
  return body;
}
