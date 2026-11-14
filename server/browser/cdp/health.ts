// What a page reports without the Runtime domain: failed requests, the Log
// domain (network, CORS, private-network blocks, interventions) and human-check
// frames. Chrome 153 does not deliver a main-world ErrorEvent or
// PromiseRejectionEvent to isolated-world listeners (measured), and console
// output needs Runtime, so uncaught errors and console lines are not seen.

import { siteOf } from "../../../shared/site.ts";
import type { CdpSession, Params } from "./connection.ts";
import type { FrameRecord } from "./frames.ts";

export const HEALTH_BUFFER_LIMIT = 200;
const REQUESTS_REMEMBERED = 2_000;
const REPORTED_TYPES = new Set(["Document", "XHR", "Fetch", "Script"]);

export interface FailedRequest {
  url: string;
  method: string;
  resourceType: string;
  /** Null when the request failed below HTTP. */
  status: number | null;
  errorText?: string;
  blockedReason?: string;
  firstParty: boolean;
}

export interface LogLine {
  source: string;
  level: string;
  text: string;
  url?: string;
}

export interface HumanCheck {
  kind: "Cloudflare Turnstile" | "Cloudflare challenge" | "reCAPTCHA" | "hCaptcha";
  frameUrl: string;
}

export interface HealthReport {
  failedRequests: FailedRequest[];
  log: LogLine[];
  humanChecks: HumanCheck[];
  dropped: { failedRequests: number; log: number };
}

/** Origin and path only: queries carry tokens. */
export function reportableUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "data:" || url.protocol === "blob:") return `${url.protocol}…`;
    return `${url.origin}${url.pathname}`.slice(0, 300);
  } catch {
    return raw.slice(0, 120);
  }
}

function hostOf(raw: string): string | null {
  try { return new URL(raw).hostname || null; } catch { return null; }
}

export function humanChecksIn(frames: readonly Pick<FrameRecord, "url" | "parentId">[]): HumanCheck[] {
  const found: HumanCheck[] = [];
  for (const frame of frames) {
    const host = hostOf(frame.url) ?? "";
    let kind: HumanCheck["kind"] | null = null;
    if (host === "challenges.cloudflare.com") kind = "Cloudflare Turnstile";
    else if (frame.parentId === null && /\/cdn-cgi\/challenge-platform\//.test(frame.url)) kind = "Cloudflare challenge";
    else if ((host === "www.google.com" || host === "www.recaptcha.net") && /\/recaptcha\//.test(frame.url)) kind = "reCAPTCHA";
    else if (host === "hcaptcha.com" || host.endsWith(".hcaptcha.com")) kind = "hCaptcha";
    if (kind && !found.some((check) => check.kind === kind)) found.push({ kind, frameUrl: reportableUrl(frame.url) });
  }
  return found;
}

class Bounded<T> {
  readonly items: T[] = [];
  dropped = 0;

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > HEALTH_BUFFER_LIMIT) {
      this.items.shift();
      this.dropped++;
    }
  }

  take(): { items: T[]; dropped: number } {
    const taken = { items: this.items.splice(0), dropped: this.dropped };
    this.dropped = 0;
    return taken;
  }
}

/** One tab's health signals since they were last taken. */
export class PageHealth {
  readonly #requests = new Map<string, { url: string; method: string }>();
  readonly #failed = new Bounded<FailedRequest>();
  readonly #log = new Bounded<LogLine>();
  readonly #pageUrl: () => string;

  constructor(pageUrl: () => string) {
    this.#pageUrl = pageUrl;
  }

  watch(session: CdpSession): () => void {
    const offs = [
      session.on("Network.requestWillBeSent", (params) => this.#sent(params)),
      session.on("Network.responseReceived", (params) => this.#response(params)),
      session.on("Network.loadingFailed", (params) => this.#failedLoad(params)),
      session.on("Network.loadingFinished", (params) => this.#requests.delete(String(params.requestId))),
      session.on("Log.entryAdded", (params) => this.#entry(params)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  take(frames: readonly Pick<FrameRecord, "url" | "parentId">[]): HealthReport {
    const failed = this.#failed.take();
    const log = this.#log.take();
    return { failedRequests: failed.items, log: log.items, humanChecks: humanChecksIn(frames), dropped: { failedRequests: failed.dropped, log: log.dropped } };
  }

  #firstParty(url: string): boolean {
    const host = hostOf(url);
    const page = hostOf(this.#pageUrl());
    return host !== null && page !== null && siteOf(host) === siteOf(page);
  }

  #sent(params: Params): void {
    const request = params.request as { url?: string; method?: string } | undefined;
    if (this.#requests.size >= REQUESTS_REMEMBERED) this.#requests.delete(this.#requests.keys().next().value!);
    this.#requests.set(String(params.requestId), { url: String(request?.url ?? ""), method: String(request?.method ?? "GET") });
  }

  #response(params: Params): void {
    const response = params.response as { url?: string; status?: number } | undefined;
    const type = String(params.type ?? "Other");
    const status = Number(response?.status);
    if (!REPORTED_TYPES.has(type) || !(status >= 400)) return;
    const url = String(response?.url ?? "");
    const method = this.#requests.get(String(params.requestId))?.method ?? "GET";
    this.#failed.push({ url: reportableUrl(url), method, resourceType: type, status, firstParty: this.#firstParty(url) });
  }

  #failedLoad(params: Params): void {
    const id = String(params.requestId);
    const request = this.#requests.get(id);
    this.#requests.delete(id);
    const type = String(params.type ?? "Other");
    if (params.canceled === true || !REPORTED_TYPES.has(type) || !request) return;
    const cors = params.corsErrorStatus as { corsError?: string } | undefined;
    this.#failed.push({
      url: reportableUrl(request.url),
      method: request.method,
      resourceType: type,
      status: null,
      errorText: String(params.errorText ?? "").slice(0, 200),
      ...(typeof params.blockedReason === "string" ? { blockedReason: params.blockedReason } : cors?.corsError ? { blockedReason: `cors:${cors.corsError}` } : {}),
      firstParty: this.#firstParty(request.url),
    });
  }

  #entry(params: Params): void {
    const entry = params.entry as { source?: string; level?: string; text?: string; url?: string } | undefined;
    if (!entry || (entry.level !== "error" && entry.level !== "warning")) return;
    this.#log.push({
      source: String(entry.source ?? "other"),
      level: entry.level,
      text: String(entry.text ?? "").slice(0, 500),
      ...(entry.url ? { url: reportableUrl(entry.url) } : {}),
    });
  }
}
