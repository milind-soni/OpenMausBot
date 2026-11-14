import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { checkSentinelInstall, type SentinelInstallCheck } from "../service-unit.ts";
import { defaultSentinelOut, outRefusal } from "./paths.ts";
import { runScan, type ScanSummary } from "./scan.ts";

export interface SentinelArgs {
  dataDir: string;
  out: string;
  json: boolean;
  queueWaitMs?: number;
  costUsd?: number;
  help?: boolean;
  checkInstall?: boolean;
}

export const SENTINEL_USAGE = `openmausbot sentinel [--data-dir DIR] [--out DIR] [--once] [--json]
                     [--queue-wait SECONDS] [--cost USD]
openmausbot sentinel --check-install [--json]

Scans an OpenMausBot data dir, read-only, for failed tool calls, stopped or
timed-out turns, long queue waits, expensive turns and retry loops, and keeps
them as issues in issues.jsonl, outside the data dir: on macOS in
~/Library/Application Support/openmausbot-sentinel, on Linux in
$XDG_STATE_HOME/openmausbot-sentinel (~/.local/state/…), or in --out. Issues
point at the evidence by id and carry a normalized one-line title; they never
copy tool output or message text.

--out         where issues.jsonl and state.json go (not in the data dir or a repository)
--once        run one scan and exit (what every run does; for schedulers)
--json        print the summary as JSON
--queue-wait  flag delegated work queued longer than this (default 300)
--cost        flag a single turn costing more than this many dollars (default 5)
--check-install  check that the installed schedule (service install --sentinel)
              still points at a node and a script that exist`;

export function parseSentinelArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SentinelArgs | { error: string; json: boolean } {
  const json = argv.includes("--json");
  let dataDir = env.OMB_DATA_DIR || join(homedir(), ".openmausbot");
  let out: string | undefined;
  const args: Omit<SentinelArgs, "dataDir" | "out"> = { json };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    try {
      if (arg === "--data-dir") dataDir = resolve(value());
      else if (arg === "--out") out = resolve(value());
      else if (arg === "--once" || arg === "--json") continue;
      else if (arg === "--help" || arg === "-h") args.help = true;
      else if (arg === "--check-install") args.checkInstall = true;
      else if (arg === "--queue-wait" || arg === "--cost") {
        // an unset shell variable is "", which Number() would read as 0
        const operand = value();
        const number = operand.trim() ? Number(operand) : NaN;
        const scaled = arg === "--queue-wait" ? number * 1000 : number;
        if (!Number.isFinite(scaled) || number < 0) return { error: `${arg} takes a number of 0 or more`, json };
        if (arg === "--queue-wait") args.queueWaitMs = scaled;
        else args.costUsd = scaled;
      } else return { error: `unknown argument "${arg}"; see openmausbot sentinel --help`, json };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), json };
    }
  }
  return { ...args, dataDir, out: out ?? defaultSentinelOut(dataDir, process.platform, homedir(), env) };
}

export interface SentinelHost {
  platform: NodeJS.Platform;
  home: string;
  exists(path: string): boolean;
  read(path: string): string;
}

const HOST: SentinelHost = { platform: process.platform, home: homedir(), exists: existsSync, read: (path) => readFileSync(path, "utf8") };

export function describeInstallCheck(check: SentinelInstallCheck): string {
  switch (check.status) {
    case "ok": return `sentinel schedule ok: ${check.unit} runs ${check.script} with ${check.node}`;
    case "stale": return `stale install: ${check.unit} needs ${check.missing.join(" and ")}, which no longer exists; rerun openmausbot service install --sentinel`;
    case "not_installed": return `no Sentinel schedule at ${check.unit}; install one with openmausbot service install --sentinel`;
    case "unreadable": return `could not read the command in ${check.unit}; rerun openmausbot service install --sentinel`;
    default: return "no Sentinel schedule to check on this platform; openmausbot service install --sentinel prints the Task Scheduler command for Windows";
  }
}

export function runSentinelCli(argv: string[], io: { log(line: string): void; error(line: string): void } = console, env: NodeJS.ProcessEnv = process.env, host: SentinelHost = HOST): number {
  const args = parseSentinelArgs(argv, env);
  const fail = (message: string, json: boolean, code = 1) => {
    if (json) io.log(JSON.stringify({ ok: false, error: message }));
    else io.error(`sentinel: ${message}`);
    return code;
  };
  if ("error" in args) return fail(args.error, args.json, 2);
  if (args.help) {
    io.log(SENTINEL_USAGE);
    return 0;
  }
  if (args.checkInstall) {
    const check = checkSentinelInstall(host.platform, host.home, host);
    const ok = check.status === "ok";
    if (args.json) io.log(JSON.stringify({ ok, ...check }));
    else if (ok) io.log(describeInstallCheck(check));
    else io.error(`sentinel: ${describeInstallCheck(check)}`);
    return ok ? 0 : 1;
  }
  let isDir = false;
  try {
    isDir = statSync(args.dataDir).isDirectory();
  } catch {}
  if (!isDir) return fail(`no OpenMausBot data dir at ${args.dataDir}; pass --data-dir with the folder that holds messages.db`, args.json);
  const refusal = outRefusal(args.out, args.dataDir);
  if (refusal) return fail(refusal, args.json);
  let summary: ScanSummary;
  try {
    summary = runScan({ dataDir: args.dataDir, out: args.out, queueWaitMs: args.queueWaitMs, costUsd: args.costUsd });
  } catch (error) {
    return fail(`scan of ${args.dataDir} failed: ${error instanceof Error ? error.message : String(error)}`, args.json);
  }
  if (args.json) io.log(JSON.stringify({ ok: true, out: args.out, ...summary }));
  else for (const line of formatSummary(summary, args.out)) io.log(line);
  return 0;
}

export function formatSummary(summary: ScanSummary, out: string): string[] {
  if (!summary.scanned) return [`sentinel: nothing changed since the last scan (${summary.totalIssues} issues in ${join(out, "issues.jsonl")})`];
  const { tool, turn, queue } = summary.records;
  const lines = [
    `sentinel: read ${tool} failed tool calls, ${turn} finished turns, ${queue} queue waits; ` +
    `${summary.added} new occurrences in ${summary.touched.length} issues (${summary.totalIssues} total)`,
  ];
  for (const issue of summary.touched.slice(0, 10)) {
    const turns = issue.wastedTurns ? `, ${issue.wastedTurns} turns` : "";
    lines.push(`  ${issue.severity.padEnd(6)} ${issue.kind.padEnd(12)} ${issue.origin.padEnd(8)} ${issue.tool ?? "-"} ×${issue.count}${turns}: ${issue.title ?? issue.sig}`);
  }
  if (summary.touched.length > 10) lines.push(`  … and ${summary.touched.length - 10} more`);
  lines.push(`issues: ${join(out, "issues.jsonl")}`);
  return lines;
}
