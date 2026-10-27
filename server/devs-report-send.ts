// Sending one @devs report to the MausBot team's endpoint and reading its answer: 201 {id}; 400 or 413 {error}; 429
// {error, retryAfter} (seconds, also Retry-After).
import { DEVS_REPORT_LIMITS, withoutContact, type DevsReportPayload } from "./devs-report.ts";

export const BUG_REPORT_PATH = "/api/bug-reports";
export const PRODUCTION_CLOUD_ORIGIN = "https://cloud.openmausbot.com";
export const STAGING_CLOUD_ORIGIN = "https://omb-cloud-staging.fly.dev";
const SEND_TIMEOUT_MS = 20_000;
const ANSWER_MAX_BYTES = 16 * 1024;

export type SendOutcome =
  | { ok: true; id: string }
  /** Worth sending again later: offline, a server error, or the endpoint's hourly limit. */
  | { ok: false; retry: true; why: "offline" | "server" | "limited"; retryAfterMs?: number }
  /** The endpoint refused this report; sending it again would be refused again. */
  | { ok: false; retry: false; why: "refused"; detail: string };

/** OMB_BUG_REPORT_URL (an https address, or http on this machine's loopback, for fixtures), else a Cloud home's own
 * Admin origin, else the staging or production Cloud. */
export function bugReportEndpoint(env: NodeJS.ProcessEnv, cloudOrigin?: string | null): string {
  const explicit = env.OMB_BUG_REPORT_URL?.trim();
  if (explicit) {
    try {
      const url = new URL(explicit);
      const loopback = url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
      if ((url.protocol === "https:" || loopback) && !url.username && !url.password) return url.href;
    } catch { /* not an address: the default below */ }
  }
  const origin = cloudOrigin ?? (env.OMB_CLOUD_STAGING === "1" ? STAGING_CLOUD_ORIGIN : PRODUCTION_CLOUD_ORIGIN);
  return `${origin.replace(/\/+$/, "")}${BUG_REPORT_PATH}`;
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ANSWER_MAX_BYTES) { await reader.cancel().catch(() => {}); return {}; }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const sentence = (value: unknown) => (typeof value === "string" ? value.replace(/\p{Cc}+/gu, " ").trim().slice(0, 200) : "");

async function post(endpoint: string, payload: DevsReportPayload, fetcher: typeof fetch): Promise<{ status: number; body: Record<string, unknown>; headers: Headers } | null> {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > DEVS_REPORT_LIMITS.body) return { status: 413, body: { error: "The report is larger than 600 KB." }, headers: new Headers() };
  try {
    const response = await fetcher(endpoint, {
      method: "POST", redirect: "error", cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return { status: response.status, body: await boundedJson(response), headers: response.headers };
  } catch {
    return null;
  }
}

export const devsReportSender = (endpoint: string, fetcher: typeof fetch = fetch) => (payload: DevsReportPayload) => sendDevsReport(endpoint, payload, fetcher);

export async function sendDevsReport(endpoint: string, payload: DevsReportPayload, fetcher: typeof fetch = fetch): Promise<SendOutcome> {
  let answer = await post(endpoint, payload, fetcher);
  // An address the endpoint will not take must not cost the person their report.
  if (answer?.status === 400 && /contact/i.test(sentence(answer.body.error)) && (payload.contactEmail || payload.contact)) {
    answer = await post(endpoint, withoutContact(payload), fetcher);
  }
  if (!answer) return { ok: false, retry: true, why: "offline" };
  const { status, body, headers } = answer;
  if (status >= 200 && status < 300) {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? { ok: true, id } : { ok: false, retry: true, why: "server" };
  }
  if (status === 429) {
    const seconds = Number(body.retryAfter ?? headers.get("retry-after"));
    return { ok: false, retry: true, why: "limited", ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: Math.ceil(seconds) * 1000 } : {}) };
  }
  if (status === 400 || status === 405 || status === 413) return { ok: false, retry: false, why: "refused", detail: sentence(body.error) || `status ${status}` };
  return { ok: false, retry: true, why: "server" };
}
