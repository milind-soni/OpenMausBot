import { serverFetch } from "./relay-server";
// The page's part of the desktop app's launch record: when it first painted, when the sidebar and the open chat were
// drawn, and how many requests left this computer before then. Marks and counts only, posted once to the local server;
// a page that cannot post loses the record and nothing else.

/** With no chat drawn by then (none open, or a slow start), what there is goes anyway. */
export const GIVE_UP_AFTER_MS = 20_000;
/** After the chat is drawn, long tasks still finishing are waited for this long before the part is sent. */
export const SETTLE_AFTER_CHAT_MS = 1_500;
const SIDEBAR_ROW = "[data-sidebar-bot-row]", CHAT_ROW = "[data-mid]";

type HostKind = "accounts" | "cloud" | "updates" | "other";
export interface PageLaunchPart {
  from: "page";
  timeOrigin: number;
  marks: Partial<Record<"pageResponse" | "firstPaint" | "sidebarDrawn" | "chatDrawn" | "lastLongTaskEnd", number>>;
  net: Partial<Record<HostKind, { n: number; ms: number }>>;
}

/** The kind of host a request went to; null for this page's own server. */
export function pageHostKind(url: string, own: string): HostKind | null {
  let host: string;
  try {
    const parsed = new URL(url, own);
    if (parsed.origin === own || !/^https?:$/.test(parsed.protocol)) return null;
    host = parsed.hostname.toLowerCase();
  } catch { return "other"; }
  if (host === "127.0.0.1" || host === "localhost") return null;
  if (host === "github.com" || host.endsWith(".github.com") || host.endsWith(".githubusercontent.com")) return "updates";
  if (host === "accounts.openmausbot.com") return "accounts";
  if (host.endsWith(".openmausbot.com") || host.endsWith(".mausbot.cloud") || host.endsWith(".fly.dev")) return "cloud";
  return "other";
}

export interface LaunchMarkDeps {
  has(selector: string): boolean;
  /** Calls `changed` whenever the document's tree changes; returns how to stop. */
  watch(changed: () => void): () => void;
  now(): number;
  timeOrigin: number;
  origin: string;
  entries(type: "navigation" | "paint" | "longtask" | "resource"): ReadonlyArray<{ name: string; startTime: number; duration: number; responseStart?: number; responseEnd?: number }>;
  later(run: () => void, ms: number): void;
  post(part: PageLaunchPart): void;
}

/** Watches until the chat is drawn (or GIVE_UP_AFTER_MS), then posts once. */
export function startLaunchMarks(deps: LaunchMarkDeps): void {
  const marks: PageLaunchPart["marks"] = {};
  let sent = false;
  let stop = () => {};
  const send = () => {
    if (sent) return;
    sent = true;
    stop();
    try {
      const until = marks.chatDrawn ?? deps.now();
      const response = deps.entries("navigation")[0]?.responseStart;
      if (response !== undefined) marks.pageResponse = response;
      const paint = deps.entries("paint").find((entry) => entry.name === "first-contentful-paint");
      if (paint) marks.firstPaint = paint.startTime;
      const longEnd = Math.max(0, ...deps.entries("longtask").map((entry) => entry.startTime + entry.duration));
      if (longEnd > 0) marks.lastLongTaskEnd = longEnd;
      const net: PageLaunchPart["net"] = {};
      for (const entry of deps.entries("resource")) {
        if (entry.startTime > until) continue;
        const kind = pageHostKind(entry.name, deps.origin);
        if (!kind) continue;
        const kept = (net[kind] ??= { n: 0, ms: 0 });
        kept.n += 1; kept.ms += Math.round(Math.max(0, (entry.responseEnd || entry.startTime + entry.duration) - entry.startTime));
      }
      deps.post({ from: "page", timeOrigin: deps.timeOrigin, marks, net });
    } catch {}
  };
  const check = () => {
    if (marks.sidebarDrawn === undefined && deps.has(SIDEBAR_ROW)) marks.sidebarDrawn = deps.now();
    if (marks.chatDrawn === undefined && deps.has(CHAT_ROW)) {
      marks.chatDrawn = deps.now();
      stop();
      deps.later(send, SETTLE_AFTER_CHAT_MS);
    }
  };
  stop = deps.watch(check);
  deps.later(send, GIVE_UP_AFTER_MS);
  check();
}

/** In the desktop app's own window only: a browser tab and a remote home's page record nothing. */
export function startDesktopLaunchMarks(): void {
  if (!("ogb" in window) || !/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return;
  try {
    const longtasks: PerformanceEntry[] = [];
    try { new PerformanceObserver((list) => { longtasks.push(...list.getEntries()); }).observe({ type: "longtask", buffered: true }); } catch {}
    startLaunchMarks({
      has: (selector) => document.querySelector(selector) !== null,
      watch(changed) {
        const observer = new MutationObserver(changed);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => observer.disconnect();
      },
      now: () => performance.now(), timeOrigin: performance.timeOrigin, origin: location.origin,
      entries: (type) => (type === "longtask" ? longtasks : performance.getEntriesByType(type)) as ReturnType<LaunchMarkDeps["entries"]>,
      later: (run, ms) => { setTimeout(run, ms); },
      post: (part) => { void serverFetch("/api/diagnostics/launch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(part), keepalive: true }).catch(() => {}); },
    });
  } catch {}
}
