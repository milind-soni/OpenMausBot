// Where each start of the desktop app spent its time: the main process, the page and this server each hand in their
// part once, the parts become one record of numbers and fixed codes, and a ring of recent launches plus a histogram per
// day is kept in the data folder. Never sent anywhere. Privacy invariant: only `parseLaunchPart`'s checked fields enter
// a record, and only `parseLaunch`'s leave the file.
import { readFileSync } from "node:fs";
import { uptime } from "node:os";

import { writeFileAtomic } from "../atomic.ts";
import { addTo, countOf, emptyHistogram, histogramQuantile, mergeInto, parseHistogram, type Histogram } from "./phases.ts";

export const LAUNCH_FILE = "launch-timings.json";
export const LAUNCH_RING_CAP = 50;
export const LAUNCH_DAYS_KEPT = 30;
/** A launch whose page never reports (hidden at login, no chat open) is recorded without it after this long. */
export const LAUNCH_SETTLE_MS = 90_000;
const DAY = 86_400_000;
/** No phase of a launch is believed past this. */
const MAX_MS = 600_000;
const CHILDREN_KEPT = 16;

/** Offsets from the app's process start, ms. In the order a launch reaches them. */
export const LAUNCH_MARKS = [
  "codeStart", "mainImported", "ready", "splashMade", "splashShown", "keysRead", "leaseTaken", "serverForked", "serverSpawned",
  "serverStarted", "serverListening", "serverReady", "windowMade", "windowNavigated", "windowShown", "pageResponse", "firstPaint",
  "sidebarDrawn", "chatDrawn", "lastLongTaskEnd",
] as const;
export type LaunchMark = (typeof LAUNCH_MARKS)[number];
const MAIN_MARKS = new Set<string>(LAUNCH_MARKS.slice(0, LAUNCH_MARKS.indexOf("pageResponse")).filter((mark) => mark !== "serverStarted"));
const PAGE_MARKS = ["pageResponse", "firstPaint", "sidebarDrawn", "chatDrawn", "lastLongTaskEnd"] as const;

/** Time inside one awaited step, ms. */
export const LAUNCH_SPANS = ["keychain", "lease", "serverBoot"] as const;
export type LaunchSpan = (typeof LAUNCH_SPANS)[number];

/** The programs a launch may start, by the name they are kept under; any other is "other". */
export const LAUNCH_CHILDREN = [
  "sysctl", "ioreg", "scutil", "codesign", "spctl", "security", "open", "defaults", "osascript", "ps", "lsof", "launchctl", "sw_vers", "which", "where",
  "reg", "wmic", "powershell", "cmd", "tasklist", "xdg-mime", "xdg-settings", "gsettings", "dbus-send", "loginctl", "getent", "id",
  "cua-driver", "cloudflared", "tailscale", "git", "node", "claude", "codex", "opencode", "grok", "gemini", "pi", "cursor-agent", "other",
] as const;
const CHILD_NAMES = new Set<string>(LAUNCH_CHILDREN);
export const LAUNCH_HOSTS = ["accounts", "cloud", "updates", "other"] as const;
export type LaunchHost = (typeof LAUNCH_HOSTS)[number];
const PLATFORMS = new Set(["darwin", "win32", "linux"]), ARCHES = new Set(["arm64", "x64", "ia32"]);
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[a-z0-9.]{1,24})?$/;
const LAUNCH_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface LaunchChild { name: string; where: "main" | "server"; n: number; ms: number }
export interface LaunchNet { n: number; ms: number }
export interface LaunchRecord {
  /** The app's process start, epoch ms. */
  at: number;
  appVersion: string | null;
  platform: string | null;
  arch: string | null;
  /** The first launch since the computer started; null when that could not be told. */
  cold: boolean | null;
  /** Started out of sight (at login): no window, so no page marks. */
  hidden: boolean;
  bots: number;
  threads: number;
  ms: Partial<Record<LaunchMark, number>>;
  spans: Partial<Record<LaunchSpan, number>>;
  children: LaunchChild[];
  /** Requests to anything but this computer before the chat was drawn, by kind of host. */
  net: Partial<Record<LaunchHost, LaunchNet>>;
  parts: Array<"main" | "page" | "server">;
}

const ms = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_MS ? Math.round(value) : undefined;
const count = (value: unknown, cap = 1_000_000): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : 0);
const epoch = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 1_500_000_000_000 && value < 10_000_000_000_000 ? Math.round(value) : undefined;
const fields = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

function childrenOf(raw: unknown, where: "main" | "server"): LaunchChild[] {
  const merged = new Map<string, LaunchChild>();
  for (const entry of Array.isArray(raw) ? raw.slice(0, 200) : []) {
    const one = fields(entry);
    const took = ms(one.ms);
    if (took === undefined) continue;
    const name = typeof one.name === "string" && CHILD_NAMES.has(one.name) ? one.name : "other";
    const kept = merged.get(name) ?? { name, where, n: 0, ms: 0 };
    kept.n += Math.max(1, count(one.n, 1_000));
    kept.ms = Math.min(MAX_MS, kept.ms + took);
    merged.set(name, kept);
  }
  return [...merged.values()].sort((left, right) => right.ms - left.ms).slice(0, CHILDREN_KEPT);
}

function netOf(raw: unknown): Partial<Record<LaunchHost, LaunchNet>> {
  const out: Partial<Record<LaunchHost, LaunchNet>> = {};
  const given = fields(raw);
  for (const host of LAUNCH_HOSTS) {
    if (!Object.hasOwn(given, host)) continue;
    const one = fields(given[host]);
    const n = count(one.n, 100_000);
    if (n) out[host] = { n, ms: ms(one.ms) ?? 0 };
  }
  return out;
}

const addNet = (into: Partial<Record<LaunchHost, LaunchNet>>, from: Partial<Record<LaunchHost, LaunchNet>>) => {
  for (const host of LAUNCH_HOSTS) {
    const one = from[host];
    if (one) into[host] = { n: (into[host]?.n ?? 0) + one.n, ms: Math.min(MAX_MS, (into[host]?.ms ?? 0) + one.ms) };
  }
};

export interface MainPart {
  from: "main"; launchId: string; processStart: number; marks: Partial<Record<LaunchMark, number>>; spans: Partial<Record<LaunchSpan, number>>;
  children: LaunchChild[]; net: Partial<Record<LaunchHost, LaunchNet>>; appVersion: string | null; platform: string | null; arch: string | null; hidden: boolean;
}
export interface PagePart {
  from: "page"; timeOrigin: number; marks: Partial<Record<(typeof PAGE_MARKS)[number], number>>; net: Partial<Record<LaunchHost, LaunchNet>>;
}
export interface ServerPart { startedAt: number; listeningAt: number; children: LaunchChild[]; net: Partial<Record<LaunchHost, LaunchNet>> }

/** What the main process or the page posted, reduced to its checked fields; null when it is neither. */
export function parseLaunchPart(raw: unknown): MainPart | PagePart | null {
  const body = fields(raw);
  if (body.from === "page") {
    const timeOrigin = epoch(body.timeOrigin);
    if (timeOrigin === undefined) return null;
    const given = fields(body.marks), marks: PagePart["marks"] = {};
    for (const mark of PAGE_MARKS) { const at = Object.hasOwn(given, mark) ? ms(given[mark]) : undefined; if (at !== undefined) marks[mark] = at; }
    return { from: "page", timeOrigin, marks, net: netOf(body.net) };
  }
  if (body.from !== "main") return null;
  const processStart = epoch(body.processStart);
  if (processStart === undefined || typeof body.launchId !== "string" || !LAUNCH_ID.test(body.launchId)) return null;
  const given = fields(body.marks), marks: MainPart["marks"] = {};
  for (const mark of MAIN_MARKS) { const at = Object.hasOwn(given, mark) ? ms(given[mark]) : undefined; if (at !== undefined) marks[mark as LaunchMark] = at; }
  const givenSpans = fields(body.spans), spans: MainPart["spans"] = {};
  for (const span of ["keychain", "lease"] as const) { const took = Object.hasOwn(givenSpans, span) ? ms(givenSpans[span]) : undefined; if (took !== undefined) spans[span] = took; }
  return {
    from: "main", launchId: body.launchId, processStart, marks, spans, children: childrenOf(body.children, "main"), net: netOf(body.net),
    appVersion: typeof body.appVersion === "string" && VERSION.test(body.appVersion) ? body.appVersion : null,
    platform: typeof body.platform === "string" && PLATFORMS.has(body.platform) ? body.platform : null,
    arch: typeof body.arch === "string" && ARCHES.has(body.arch) ? body.arch : null, hidden: body.hidden === true,
  };
}

/** A record read back from the file: anything unchecked is dropped, anything malformed is no record. */
export function parseLaunch(raw: unknown): LaunchRecord | null {
  const body = fields(raw);
  const at = epoch(body.at);
  if (at === undefined) return null;
  const given = fields(body.ms), marks: LaunchRecord["ms"] = {};
  for (const mark of LAUNCH_MARKS) { const value = Object.hasOwn(given, mark) ? ms(given[mark]) : undefined; if (value !== undefined) marks[mark] = value; }
  const givenSpans = fields(body.spans), spans: LaunchRecord["spans"] = {};
  for (const span of LAUNCH_SPANS) { const took = Object.hasOwn(givenSpans, span) ? ms(givenSpans[span]) : undefined; if (took !== undefined) spans[span] = took; }
  const children = (Array.isArray(body.children) ? body.children : []).flatMap((entry) => {
    const one = fields(entry);
    return one.where === "main" || one.where === "server" ? childrenOf([one], one.where) : [];
  }).slice(0, CHILDREN_KEPT * 2);
  return {
    at, appVersion: typeof body.appVersion === "string" && VERSION.test(body.appVersion) ? body.appVersion : null,
    platform: typeof body.platform === "string" && PLATFORMS.has(body.platform) ? body.platform : null,
    arch: typeof body.arch === "string" && ARCHES.has(body.arch) ? body.arch : null,
    cold: typeof body.cold === "boolean" ? body.cold : null, hidden: body.hidden === true, bots: count(body.bots), threads: count(body.threads),
    ms: marks, spans, children, net: netOf(body.net),
    parts: (["main", "page", "server"] as const).filter((part) => Array.isArray(body.parts) && body.parts.includes(part)),
  };
}

/** The phases a day's histograms are kept for: three marks, and two gaps between marks. */
export const LAUNCH_PHASES = ["splashShown", "windowShown", "chatDrawn", "forkToListening", "keychain"] as const;
export type LaunchPhase = (typeof LAUNCH_PHASES)[number];
export function launchPhaseMs(launch: LaunchRecord): Partial<Record<LaunchPhase, number>> {
  const { serverForked, serverListening } = launch.ms;
  return {
    splashShown: launch.ms.splashShown, windowShown: launch.ms.windowShown, chatDrawn: launch.ms.chatDrawn,
    forkToListening: serverForked !== undefined && serverListening !== undefined && serverListening >= serverForked ? serverListening - serverForked : undefined,
    keychain: launch.spans.keychain,
  };
}

interface DaySlot { day: number; launches: number; cold: number; phases: Partial<Record<LaunchPhase, Histogram>> }
export interface LaunchPhaseStats { p50: number; p90: number; max: number; n: number }
export interface LaunchStats { days: number; launches: number; cold: number; phases: Partial<Record<LaunchPhase, LaunchPhaseStats>> }

export interface LaunchTimingsOptions {
  /** The saved ring and days; absent: memory only. */
  file?: string;
  now?: () => number;
  /** Seconds since the computer started. */
  uptimeS?: () => number;
  counts?: () => { bots: number; threads: number };
  /** This server's own start and what it started and asked for, read once when the record is written. */
  server?: () => { startedAt: number; listeningAt: number; children?: unknown; net?: unknown } | null;
  /** This server's launch id (the one its parent gave it); a main part under another id is not this launch. */
  launchId?: string | null;
  settleMs?: number;
}

export function createLaunchTimings(options: LaunchTimingsOptions = {}) {
  const now = options.now ?? Date.now;
  const settleMs = options.settleMs ?? LAUNCH_SETTLE_MS;
  const ring: LaunchRecord[] = [];
  const days = new Map<number, DaySlot>();
  let lastLaunchAt = 0;
  let main: MainPart | null = null, page: PagePart | null = null;
  let recorded = false, settle: ReturnType<typeof setTimeout> | null = null;

  if (options.file) {
    try {
      const saved = JSON.parse(readFileSync(options.file, "utf8")) as { v?: number; ring?: unknown[]; days?: unknown[]; lastLaunchAt?: unknown };
      if (saved?.v === 1) {
        for (const raw of (Array.isArray(saved.ring) ? saved.ring : []).slice(-LAUNCH_RING_CAP)) { const launch = parseLaunch(raw); if (launch) ring.push(launch); }
        for (const raw of (Array.isArray(saved.days) ? saved.days : []).slice(-LAUNCH_DAYS_KEPT)) {
          const one = fields(raw);
          if (typeof one.day !== "number" || !Number.isSafeInteger(one.day) || one.day < 0) continue;
          const given = fields(one.phases), phases: DaySlot["phases"] = {};
          for (const phase of LAUNCH_PHASES) if (Object.hasOwn(given, phase)) phases[phase] = parseHistogram(given[phase]);
          days.set(one.day, { day: one.day, launches: count(one.launches), cold: count(one.cold), phases });
        }
        lastLaunchAt = epoch(saved.lastLaunchAt) ?? 0;
      }
    } catch {}
  }

  const save = () => {
    if (!options.file) return;
    try { writeFileAtomic(options.file, JSON.stringify({ v: 1, lastLaunchAt, ring, days: [...days.values()] }), { mode: 0o600, durable: false }); } catch {}
  };

  const serverPart = (): ServerPart | null => {
    let part: ReturnType<NonNullable<LaunchTimingsOptions["server"]>> = null;
    try { part = options.server?.() ?? null; } catch {}
    const startedAt = epoch(part?.startedAt), listeningAt = epoch(part?.listeningAt);
    return part && startedAt !== undefined && listeningAt !== undefined ? { startedAt, listeningAt, children: childrenOf(part.children, "server"), net: netOf(part.net) } : null;
  };
  const record = () => {
    if (recorded || !main) return;
    recorded = true;
    if (settle) clearTimeout(settle);
    settle = null;
    const start = main.processStart;
    const marks: LaunchRecord["ms"] = { ...main.marks };
    const spans: LaunchRecord["spans"] = { ...main.spans };
    const net: LaunchRecord["net"] = {};
    addNet(net, main.net);
    const parts: LaunchRecord["parts"] = ["main"];
    // A page that began long before or after this launch's window did is another load (a reload, another window).
    const navigated = main.marks.windowNavigated;
    const ours = page && navigated !== undefined && Math.abs(page.timeOrigin - (start + navigated)) <= 5_000 ? page : null;
    if (ours) {
      for (const mark of PAGE_MARKS) { const at = ours.marks[mark]; const offset = at === undefined ? undefined : ms(ours.timeOrigin + at - start); if (offset !== undefined) marks[mark] = offset; }
      addNet(net, ours.net);
      parts.push("page");
    }
    const children = [...main.children];
    const server = serverPart();
    if (server) {
      const started = ms(server.startedAt - start), listening = ms(server.listeningAt - start);
      if (started !== undefined) marks.serverStarted = started;
      if (listening !== undefined) marks.serverListening ??= listening;
      const boot = ms(server.listeningAt - server.startedAt);
      if (boot !== undefined) spans.serverBoot = boot;
      children.push(...server.children);
      addNet(net, server.net);
      parts.push("server");
    }
    const bootedAt = now() - (options.uptimeS ?? uptime)() * 1000;
    const counts = (() => { try { return options.counts?.() ?? { bots: 0, threads: 0 }; } catch { return { bots: 0, threads: 0 }; } })();
    const launch: LaunchRecord = {
      at: start, appVersion: main.appVersion, platform: main.platform, arch: main.arch,
      // With no earlier launch on record there is nothing to compare the computer's start with.
      cold: lastLaunchAt > 0 && Number.isFinite(bootedAt) && bootedAt > 0 ? lastLaunchAt < bootedAt : null, hidden: main.hidden,
      bots: count(counts.bots), threads: count(counts.threads), ms: marks, spans, children, net, parts,
    };
    lastLaunchAt = Math.max(lastLaunchAt, start);
    ring.push(launch);
    if (ring.length > LAUNCH_RING_CAP) ring.splice(0, ring.length - LAUNCH_RING_CAP);
    const day = Math.floor(start / DAY);
    const slot = days.get(day) ?? { day, launches: 0, cold: 0, phases: {} };
    slot.launches += 1;
    if (launch.cold) slot.cold += 1;
    for (const [phase, value] of Object.entries(launchPhaseMs(launch)) as Array<[LaunchPhase, number | undefined]>) {
      if (value !== undefined) addTo(slot.phases[phase] ??= emptyHistogram(), value);
    }
    days.set(day, slot);
    for (const old of [...days.keys()].sort((left, right) => left - right).slice(0, Math.max(0, days.size - LAUNCH_DAYS_KEPT))) days.delete(old);
    save();
  };
  const settleSoon = () => {
    if (recorded || settle) return;
    settle = setTimeout(record, settleMs);
    settle.unref?.();
  };

  return {
    /** A part from the main process or the page. `complete` once this launch's record is written: the sender may stop. */
    note(raw: unknown): { ok: boolean; complete: boolean } {
      const part = parseLaunchPart(raw);
      if (!part) return { ok: false, complete: recorded };
      if (recorded) return { ok: true, complete: true };
      if (part.from === "main") {
        if (options.launchId && part.launchId !== options.launchId) return { ok: false, complete: false };
        if (ring.some((launch) => launch.at === part.processStart)) { recorded = true; return { ok: true, complete: true }; }
        main = part;
      } else page ??= part;
      // A hidden start has no page to wait for.
      if (main && (page || main.hidden)) record(); else settleSoon();
      return { ok: true, complete: recorded };
    },
    recent: (limit = LAUNCH_RING_CAP): LaunchRecord[] => ring.slice(-limit).map((launch) => ({ ...launch, ms: { ...launch.ms }, spans: { ...launch.spans }, children: launch.children.map((child) => ({ ...child })), net: { ...launch.net }, parts: [...launch.parts] })),
    stats(windowDays = LAUNCH_DAYS_KEPT): LaunchStats {
      const from = Math.floor(now() / DAY) - windowDays;
      const merged: Partial<Record<LaunchPhase, Histogram>> = {};
      let launches = 0, cold = 0;
      for (const slot of days.values()) {
        if (slot.day <= from) continue;
        launches += slot.launches; cold += slot.cold;
        for (const phase of LAUNCH_PHASES) if (slot.phases[phase]) mergeInto(merged[phase] ??= emptyHistogram(), slot.phases[phase]);
      }
      const phases: LaunchStats["phases"] = {};
      for (const phase of LAUNCH_PHASES) {
        const histogram = merged[phase];
        if (histogram && countOf(histogram)) phases[phase] = { p50: histogramQuantile(histogram, 0.5), p90: histogramQuantile(histogram, 0.9), max: histogram.max, n: countOf(histogram) };
      }
      return { days: windowDays, launches, cold, phases };
    },
    /** A clean exit: a launch still waiting for its page is recorded as it stands. */
    flush() { record(); },
  };
}
export type LaunchTimings = ReturnType<typeof createLaunchTimings>;
