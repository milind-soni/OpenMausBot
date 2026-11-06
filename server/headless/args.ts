import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** What the process exits with. Scripts and CI branch on these. */
export const EXIT = {
  done: 0,
  failed: 1,
  usage: 2,
  needsInput: 3,
  timeout: 4,
  unreachable: 5,
  changes: 6,
  /** `doctor --host`: this machine is missing something the server needs. */
  hostMissing: 7,
  interrupted: 130,
} as const;

export class HeadlessError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(message: string, exitCode: number = EXIT.failed, hint?: string) {
    super(message);
    this.exitCode = exitCode;
    if (hint !== undefined) this.hint = hint;
  }
}

export const usageError = (message: string, hint?: string) => new HeadlessError(message, EXIT.usage, hint);

const GLOBAL = {
  url: { type: "string" },
  port: { type: "string" },
  "token-file": { type: "string" },
  json: { type: "boolean" },
  quiet: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} satisfies ParseArgsOptionsConfig;

const TARGET = {
  bot: { type: "string" },
  channel: { type: "string" },
  thread: { type: "string" },
  task: { type: "string" },
} satisfies ParseArgsOptionsConfig;

const TEXT = {
  text: { type: "string" },
  "message-file": { type: "string" },
} satisfies ParseArgsOptionsConfig;

const WAITING = {
  timeout: { type: "string" },
  "on-input": { type: "string" },
  "on-timeout": { type: "string" },
  strict: { type: "boolean" },
} satisfies ParseArgsOptionsConfig;

const VERBS: Record<string, { options: ParseArgsOptionsConfig; positionals: number }> = {
  doctor: { options: { wait: { type: "string" }, host: { type: "boolean" }, "data-dir": { type: "string" }, domain: { type: "string" } }, positionals: 0 },
  bots: { options: {}, positionals: 0 },
  channels: { options: {}, positionals: 0 },
  models: { options: {}, positionals: 0 },
  messages: { options: { ...TARGET, limit: { type: "string" } }, positionals: 1 },
  send: { options: { ...TARGET, ...TEXT, title: { type: "string" }, "send-id": { type: "string" }, "dry-run": { type: "boolean" } }, positionals: 2 },
  "send-channel": { options: { ...TARGET, ...TEXT, title: { type: "string" }, "send-id": { type: "string" }, "dry-run": { type: "boolean" } }, positionals: 2 },
  run: {
    options: { ...TARGET, ...TEXT, ...WAITING, title: { type: "string" }, wait: { type: "string" }, export: { type: "string" }, force: { type: "boolean" },
      "send-id": { type: "string" } },
    positionals: 2,
  },
  wait: { options: { ...TARGET, ...WAITING, for: { type: "string" }, since: { type: "string" } }, positionals: 1 },
  interrupt: { options: { ...TARGET, tree: { type: "boolean" }, "dry-run": { type: "boolean" } }, positionals: 1 },
  "new-bot": {
    options: { name: { type: "string" }, title: { type: "string" }, team: { type: "string" }, section: { type: "string" },
      model: { type: "string" }, instance: { type: "string" }, effort: { type: "string" } },
    positionals: 1,
  },
  "new-channel": { options: { name: { type: "string" }, members: { type: "string" }, team: { type: "string" }, section: { type: "string" } }, positionals: 1 },
  "set-model": { options: { ...TARGET, model: { type: "string" }, instance: { type: "string" }, effort: { type: "string" }, "dry-run": { type: "boolean" } }, positionals: 1 },
  edit: { options: { ...TARGET, ...TEXT, message: { type: "string" }, "dry-run": { type: "boolean" } }, positionals: 2 },
  export: {
    options: { ...TARGET, out: { type: "string" }, root: { type: "string" }, since: { type: "string" }, "max-files": { type: "string" },
      "max-screens": { type: "string" }, "max-bytes": { type: "string" }, force: { type: "boolean" } },
    positionals: 1,
  },
  events: {
    options: { thread: { type: "string", multiple: true }, job: { type: "string" }, "until-settled": { type: "boolean" },
      kind: { type: "string" }, since: { type: "string" }, screens: { type: "boolean" },
      // the output is always JSON lines; --jsonl says so and changes nothing
      jsonl: { type: "boolean" } },
    positionals: 0,
  },
  "team apply": {
    options: { "dry-run": { type: "boolean" }, check: { type: "boolean" }, prune: { type: "boolean" },
      "rotate-secrets": { type: "boolean" }, "wait-idle": { type: "string" } },
    positionals: 1,
  },
  "team export": { options: { team: { type: "string", multiple: true }, out: { type: "string" } }, positionals: 0 },
  "engine set": {
    options: { "key-env": { type: "string" }, "key-file": { type: "string" }, "base-url": { type: "string" },
      "only-claude-api": { type: "boolean" }, install: { type: "boolean" }, rotate: { type: "boolean" }, "dry-run": { type: "boolean" } },
    positionals: 1,
  },
  "engine list": { options: {}, positionals: 0 },
  connect: {
    options: { code: { type: "string" }, out: { type: "string" }, label: { type: "string" }, client: { type: "boolean" }, force: { type: "boolean" } },
    positionals: 1,
  },
  mcp: { options: {}, positionals: 0 },
  "token create": { options: { out: { type: "string" }, scope: { type: "string" }, expires: { type: "string" }, force: { type: "boolean" } }, positionals: 1 },
  "token list": { options: {}, positionals: 0 },
  "token revoke": { options: {}, positionals: 1 },
};

export const HEADLESS_VERBS: ReadonlySet<string> = new Set(Object.keys(VERBS).map((verb) => verb.split(" ")[0]!));

/** Verbs that change something; control-omb refuses them on a discovered server. */
export const MUTATING_VERBS: ReadonlySet<string> = new Set([
  "send", "send-channel", "run", "interrupt", "new-bot", "new-channel", "set-model", "edit", "team apply", "engine set", "token create", "token revoke",
]);

export type Flags = Record<string, string | boolean | string[] | undefined>;

export interface ParsedCommand {
  verb: string;
  flags: Flags;
  positionals: string[];
}

const SUBCOMMANDS = new Map([["team", ["apply", "export"]], ["engine", ["set", "list"]], ["token", ["create", "list", "revoke"]]]);

/** Strict: an unknown flag or a missing value is a usage error (exit 2). */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const [head, ...rest] = argv;
  if (!head) throw usageError("name a verb", "run openmausbot help");
  let verb = head;
  let args = rest;
  const actions = SUBCOMMANDS.get(head);
  if (actions) {
    const action = rest[0];
    if (!action || !actions.includes(action)) {
      if (action === "--help" || action === "-h") return { verb: head, flags: { help: true }, positionals: [] };
      throw usageError(`${head} needs one of: ${actions.join(", ")}`, `run openmausbot help ${head}`);
    }
    verb = `${head} ${action}`;
    args = rest.slice(1);
  }
  const spec = VERBS[verb];
  if (!spec) throw usageError(`unknown verb "${head}"`, "run openmausbot help");
  let parsed: { values: Flags; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...args], options: { ...GLOBAL, ...spec.options }, strict: true, allowPositionals: true }) as typeof parsed;
  } catch (error) {
    throw usageError(error instanceof Error ? error.message.replace(/^Unknown option/, "unknown option") : String(error), `run openmausbot help ${head}`);
  }
  if (!parsed.values.help && parsed.positionals.length > spec.positionals) {
    throw usageError(`${verb} takes at most ${spec.positionals} value${spec.positionals === 1 ? "" : "s"} besides its flags; put text with spaces in quotes`,
      `run openmausbot help ${head}`);
  }
  return { verb, flags: parsed.values, positionals: parsed.positionals };
}

export const flag = (flags: Flags, name: string): string | undefined => {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
};

export function requiredFlag(flags: Flags, name: string): string {
  const value = flag(flags, name)?.trim();
  if (!value) throw usageError(`--${name} is required`);
  return value;
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;
const DAY = 24 * 3_600_000;
const UNIT: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: DAY };

/** `90`, `90s`, `5m`, `2h`, `30d` (a bare number is seconds) to milliseconds. */
export function parseDuration(raw: string, name: string, bounds: { min?: number; max?: number } = {}): number {
  const match = DURATION.exec(raw.trim());
  const min = bounds.min ?? 1_000;
  const max = bounds.max ?? DAY;
  const ms = match ? Math.round(Number(match[1]) * UNIT[match[2] ?? "s"]!) : NaN;
  if (!Number.isFinite(ms) || ms < min || ms > max) {
    throw usageError(`${name} must be a duration from ${describeMs(min)} to ${describeMs(max)}, such as ${max > DAY ? "12h, 30d or 90d" : "90, 90s, 5m or 2h"}`);
  }
  return ms;
}

export const describeMs = (ms: number): string =>
  ms === 0 ? "0s" : ms > DAY && ms % DAY === 0 ? `${ms / DAY}d` : ms % 3_600_000 === 0 ? `${ms / 3_600_000}h`
    : ms % 60_000 === 0 ? `${ms / 60_000}m` : ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`;

const SIZE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i;
const SIZE_UNIT: Record<string, number> = { b: 1, kb: 1_000, mb: 1_000_000, gb: 1_000_000_000 };

/** `500MB`, `2GB`, `1024` (bytes) to bytes. */
export function parseSize(raw: string, name: string): number {
  const match = SIZE.exec(raw.trim());
  const bytes = match ? Math.round(Number(match[1]) * SIZE_UNIT[(match[2] ?? "b").toLowerCase()]!) : NaN;
  if (!Number.isFinite(bytes) || bytes < 1) throw usageError(`${name} must be a size such as 500MB, 2GB or 1048576`);
  return bytes;
}

export function parseCount(raw: string | undefined, name: string, fallback: number, max: number, min = 1): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw usageError(`${name} must be a whole number from ${min} to ${max}`);
  return value;
}

export function oneOf<T extends string>(raw: string | undefined, name: string, allowed: readonly T[], fallback: T): T {
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw usageError(`${name} must be one of: ${allowed.join(", ")}`);
  return raw as T;
}
