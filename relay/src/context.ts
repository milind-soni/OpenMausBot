import type { KeyObject } from "node:crypto";
import type { Limits } from "./config.ts";
import type { HostBudgets, Hosts } from "./hosts.ts";
import type { Logger } from "./log.ts";
import type { Metrics } from "./metrics.ts";
import type { Heartbeat } from "./socket.ts";

/** What every connection handler shares on one node. */
export interface Context {
  node: string;
  limits: Limits;
  tokenKeys: ReadonlyMap<string, KeyObject>;
  hosts: Hosts;
  budgets: HostBudgets;
  heartbeat: Heartbeat;
  metrics: Metrics;
  log: Logger;
  /** Monotonic milliseconds, for every duration the relay measures. */
  now: () => number;
  /** Wall-clock seconds, only for token `iat`/`exp` and the daily byte budget. */
  wallSeconds: () => number;
}
