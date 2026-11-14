// The "Page reported after this action" line from what the driver saw without the Runtime domain: the site's own
// failed documents, APIs and scripts, Chrome's own error lines (network, CORS, blocked requests) and human checks.
import { collapsePath, healthLine, sanitizePageText, type FailedRequest, type HealthDelta } from "../browser-page-health.ts";
import type { HealthReport } from "./cdp/health.ts";

const SHOWN_TYPES = new Set(["document", "fetch", "xhr", "script"]);
const SHOWN_PER_VISIT = 200;
const KEPT = 20;
const KEPT_CHARS = 300;

function request(failed: HealthReport["failedRequests"][number]): FailedRequest | null {
  let url: URL;
  try { url = new URL(failed.url); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return { method: failed.method, host: url.hostname.toLowerCase(), path: collapsePath(url.pathname), status: failed.status, type: failed.resourceType, firstParty: failed.firstParty };
}

/** One tab's signatures already reported on the current visit, so a page that keeps failing is reported once. */
export class HealthShown {
  #visit = "";
  readonly #shown = new Set<string>();

  once(visit: string, signature: string): boolean {
    if (visit !== this.#visit) {
      this.#visit = visit;
      this.#shown.clear();
    }
    if (this.#shown.has(signature)) return false;
    if (this.#shown.size < SHOWN_PER_VISIT) this.#shown.add(signature);
    return true;
  }
}

export function visitOf(pageUrl: string, loaderId: string | null): string {
  try {
    const url = new URL(pageUrl);
    return `${url.origin}${url.pathname}\u0000${loaderId ?? ""}`;
  } catch {
    return `${pageUrl}\u0000${loaderId ?? ""}`;
  }
}

/** Null when there is nothing new to say. Every part is page output: sanitized, capped and quoted. */
export function pageHealthLine(report: HealthReport, { pageUrl, loaderId, shown }: { pageUrl: string; loaderId: string | null; shown: HealthShown }): string | null {
  const visit = visitOf(pageUrl, loaderId);
  let pageHost: string | null = null;
  try { pageHost = new URL(pageUrl).hostname.toLowerCase(); } catch {}
  const requests = report.failedRequests
    .flatMap((failed) => request(failed) ?? [])
    .filter((failed) => failed.firstParty && SHOWN_TYPES.has(failed.type.toLowerCase())
      && shown.once(visit, `r\u0000${failed.method}\u0000${failed.host}${failed.path}\u0000${failed.status}`))
    .slice(0, KEPT);
  const consoleLines = report.log
    .filter((line) => line.level === "error")
    .map((line) => ({ level: "error", text: sanitizePageText(line.text, KEPT_CHARS) }))
    .filter((line) => line.text && shown.once(visit, `c\u0000${line.text}`))
    .slice(0, KEPT);
  const delta: HealthDelta = { requests, errors: [], console: consoleLines };
  const parts = [healthLine(delta, [], "after", 0, pageHost)];
  const checks = report.humanChecks.filter((check) => shown.once(visit, `h\u0000${check.kind}`));
  if (checks.length) {
    parts.push(`The page shows a human check (${checks.map((check) => check.kind).join(", ")}). Call request_sign_in so the person can solve it; do not try to solve it yourself.`);
  }
  const text = parts.filter((part): part is string => Boolean(part)).join(" ");
  return text || null;
}
