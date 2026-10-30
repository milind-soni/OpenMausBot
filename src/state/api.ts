// The renderer's JSON request helper. A Cloud home that went to sleep is never woken by a background poll
// (src/lib/cloud-power.ts), and a page out of sight sends none at all.
import { asleepAnswer, BACKGROUND_HEADER, cloudAsleep, markCloudAsleep, markCloudAwake, pageHidden, pageShown } from "../lib/cloud-power";
import { lacksAdminScope } from "../lib/admin-scope";
import { noteRefusedRequest } from "../lib/session-ended";

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

type ApiInit = RequestInit & { timeoutMs?: number; background?: boolean };
/** Background reads waiting for a hidden page to show again, one per path: a poll that ticks while hidden asks once. */
const heldReads = new Map<string, Promise<unknown>>();

/** `background`: a poll nobody asked for just now. It never wakes a Cloud home that went to sleep (it is refused here
 * instead, src/lib/cloud-power.ts) and the home doesn't count it as someone using it. Anything else wakes it. While the
 * page is hidden (a background tab, a minimized window) a background request waits until it shows again, so a page out of
 * sight never reaches a Cloud home on its own: a Cloud home asleep is woken by any request that reaches it. */
export async function api<T = any>(path: string, init?: ApiInit): Promise<T> {
  const { timeoutMs, signal, background, headers, ...rest } = init ?? {};
  if (background && pageHidden()) return heldUntilShown<T>(path, init!);
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
    const refused = new ApiError(message, res.status, body);
    if (res.status === 401 || (res.status === 403 && !lacksAdminScope(refused))) noteRefusedRequest();
    throw refused;
  }
  return body;
}

/** A background request from a hidden page, sent once it shows again (src/lib/cloud-power.ts `pageShown`), by then refused if
 * the Cloud home fell asleep meanwhile. Reads of one path without a signal of their own share one request. */
function heldUntilShown<T>(path: string, init: ApiInit): Promise<T> {
  const shared = (init.method ?? "GET").toUpperCase() === "GET" && !init.signal;
  const waiting = shared ? heldReads.get(path) : undefined;
  if (waiting) return waiting as Promise<T>;
  const sent = pageShown(init.signal ?? undefined).then(() => api<T>(path, init));
  if (!shared) return sent;
  heldReads.set(path, sent);
  void sent.finally(() => { if (heldReads.get(path) === sent) heldReads.delete(path); }).catch(() => {});
  return sent;
}
