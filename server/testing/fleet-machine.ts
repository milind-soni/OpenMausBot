import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { FleetDeps } from "../fleet-cli.ts";
import { meterLedgerText } from "../fleet-metering.ts";
import { readUsage, summarizeUsage } from "../usage-ledger.ts";

export interface FleetMachineOptions {
  /** Commands whose `argv.join(" ")` starts with one of these exit 1. */
  failing?: string[];
  beforeRun?(argv: string[]): Promise<void>;
  root?: boolean;
  /** Features the licence key entitles; none by default. */
  features?: string[];
  /** Unix users whose ledger cannot be metered: their people read throws, as an unsafe tenant file does. */
  unmeterable?: string[];
}

/**
 * A machine that records what the fleet does to it. Registry and file writes land in `files`; tenant ledgers are read from
 * real files under `root`, so a test can append real usage rows. No systemd, nftables, Caddy or accounts are touched.
 */
export function fleetMachine(root: string, options: FleetMachineOptions = {}) {
  const files = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const deps: FleetDeps = {
    isRoot: () => options.root ?? true,
    run: async (argv) => {
      calls.push(argv.join(" "));
      await options.beforeRun?.(argv);
      if (argv[0] === "systemctl" && argv[1] === "is-active") return { code: 0, output: "active\n" };
      return options.failing?.some((prefix) => argv.join(" ").startsWith(prefix)) ? { code: 1, output: "unit failed: secret-token\n" } : { code: 0, output: "" };
    },
    readText: (path) => files.get(path) ?? null,
    pathExists: (path) => files.has(path),
    readBytes: (path) => bytes.get(path) ?? null,
    listDir: (path) => [...files.keys()].filter((name) => posix.dirname(name) === path).map((name) => posix.basename(name)),
    usage: (dataDir, owner, now) => {
      calls.push(`usage ${dataDir} as ${owner}`);
      const total = summarizeUsage(readUsage(dataDir, { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now }), "bot").total;
      return { turns: total.turns, costUsd: total.costUsd, billableUsd: null };
    },
    people: async (dataDir, owner, month, maxUsers) => {
      calls.push(`people ${dataDir} ${month} as ${owner}`);
      if (options.unmeterable?.includes(owner)) throw new Error("unsafe workspace file or directory");
      const file = join(dataDir, "usage", `${month}.jsonl`);
      const configFile = join(dataDir, "config.json");
      const config = files.get(configFile) ?? (existsSync(configFile) ? readFileSync(configFile, "utf8") : null);
      return meterLedgerText(existsSync(file) ? readFileSync(file, "utf8") : "", month, maxUsers, config);
    },
    entitlements: async () => (feature) => options.features?.includes(feature) ?? false,
    writeText: (path, content) => { files.set(path, content); },
    mkdir: () => {},
    appendOnce: () => {},
    remove: (path) => { files.delete(path); },
    health: async () => true,
  };
  return { deps, files, bytes, calls, root };
}
