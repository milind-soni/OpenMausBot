// The launch record as people read it (plain lines in the desktop's diagnostics and a @devs report) and as the health
// read carries it (a few numbers). Built only from a LaunchRecord's checked fields.
import { LAUNCH_HOSTS, LAUNCH_MARKS, LAUNCH_PHASES, launchPhaseMs, type LaunchPhase, type LaunchPhaseStats, type LaunchRecord, type LaunchStats } from "./launch-timings.ts";
import { exactQuantile } from "./phases.ts";

/** `stats`: the days' histograms, whose percentiles are bucket edges. `recent`: the ring, newest last. */
export interface LaunchSources { stats: LaunchStats; recent: LaunchRecord[] }

/** Exact percentiles over the kept launches. */
export function recentLaunchStats(recent: readonly LaunchRecord[]): Partial<Record<LaunchPhase, LaunchPhaseStats>> {
  const out: Partial<Record<LaunchPhase, LaunchPhaseStats>> = {};
  for (const phase of LAUNCH_PHASES) {
    const values = recent.flatMap((launch) => { const ms = launchPhaseMs(launch)[phase]; return ms === undefined ? [] : [ms]; }).sort((left, right) => left - right);
    if (values.length) out[phase] = { p50: exactQuantile(values, 0.5), p90: exactQuantile(values, 0.9), max: values.at(-1)!, n: values.length };
  }
  return out;
}
const SHOWN = 3;
const PHASE_NAMES: Record<LaunchPhase, string> = { splashShown: "splash shown", windowShown: "window shown", chatDrawn: "chat drawn", forkToListening: "server fork to listening", keychain: "keychain read" };

const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`);
const iso = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");

export function launchLine(launch: LaunchRecord): string {
  const marks = LAUNCH_MARKS.flatMap((mark) => (launch.ms[mark] === undefined ? [] : [`${mark} ${took(launch.ms[mark])}`]));
  const spans = Object.entries(launch.spans).map(([span, ms]) => `${span} ${took(ms)}`);
  const children = launch.children.map((child) => `${child.name}${child.where === "server" ? " (server)" : ""}${child.n > 1 ? ` ${child.n}x` : ""} ${took(child.ms)}`);
  const net = LAUNCH_HOSTS.flatMap((host) => (launch.net[host] ? [`${host} ${launch.net[host].n} in ${took(launch.net[host].ms)}`] : []));
  return `${iso(launch.at)} ${launch.appVersion ?? "?"} ${launch.platform ?? "?"} ${launch.arch ?? "?"} ${launch.cold === null ? "" : launch.cold ? "cold " : "warm "}${launch.hidden ? "hidden " : ""}`
    + `(${launch.parts.join("+")}; ${launch.bots} bots, ${launch.threads} conversations): ${marks.join(", ")}`
    + (spans.length ? `; inside: ${spans.join(", ")}` : "") + (children.length ? `; programs started: ${children.join(", ")}` : "")
    + `; requests off this computer before the chat: ${net.length ? net.join(", ") : "none"}`;
}

const phaseLine = (phases: Partial<Record<LaunchPhase, LaunchPhaseStats>>, upTo = "") =>
  LAUNCH_PHASES.flatMap((phase) => { const one = phases[phase]; return one ? [`${PHASE_NAMES[phase]} p50 ${upTo}${took(one.p50)} p90 ${upTo}${took(one.p90)} max ${took(one.max)}`] : []; }).join("; ");

/** Plain lines: the kept launches' exact percentiles, the days' bucketed ones, then the latest few launches, newest last.
 * Empty where no launch was ever recorded. */
export function launchLines(sources: LaunchSources | null | undefined): string[] {
  if (!sources || (!sources.stats.launches && !sources.recent.length)) return [];
  const { stats, recent } = sources;
  const days = phaseLine(stats.phases, "under ");
  return [
    `App launches (times from process start): ${stats.launches} in the last ${stats.days} days, ${stats.cold} of them the first since the computer started`,
    ...(recent.length ? [`  Latest ${recent.length}: ${phaseLine(recentLaunchStats(recent))}`] : []),
    ...(days ? [`  By day, last ${stats.days} days (counted in steps, so each reads up to a quarter high): ${days}`] : []),
    ...recent.slice(-SHOWN).map((launch) => `  ${launchLine(launch)}`),
  ];
}

/** For the health read: the kept launches' percentiles, the days' counts and the latest launch's marks. */
export function launchHealth(sources: LaunchSources | null | undefined) {
  if (!sources || (!sources.stats.launches && !sources.recent.length)) return null;
  const last = sources.recent.at(-1);
  return { days: sources.stats.days, launches: sources.stats.launches, cold: sources.stats.cold, recent: recentLaunchStats(sources.recent), byDay: sources.stats.phases,
    last: last ? { at: last.at, cold: last.cold, ms: last.ms, spans: last.spans } : null };
}
export type LaunchHealth = ReturnType<typeof launchHealth>;
