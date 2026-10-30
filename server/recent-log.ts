// The server's latest warnings and errors, kept in memory for a @devs report: the server log itself lives where its
// parent put it (the desktop app's server.log, a Cloud machine's log stream), out of the server's reach.
import { format } from "node:util";

import { redactSecretsInText } from "./redact.ts";

const KEPT = 200;
const LINE_MAX = 600;

export type RecentLog = () => string[];

/** Wraps `target`'s warn and error once; each call still prints as before. Lines are redacted when kept. */
export function captureRecentLog(target: Pick<Console, "warn" | "error"> = console, now: () => number = Date.now): RecentLog {
  const kept: string[] = [];
  for (const level of ["warn", "error"] as const) {
    const print = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      try {
        const line = redactSecretsInText(format(...args)).replace(/\s+/g, " ").trim();
        if (line) kept.push(`${new Date(now()).toISOString()} ${level} ${line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line}`);
        if (kept.length > KEPT) kept.splice(0, kept.length - KEPT);
      } catch { /* keeping a line never stops it printing */ }
      print(...args);
    };
  }
  return () => [...kept];
}
