import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, sep } from "node:path";

import type { CommandAllowlistCandidate, CommandAllowlistRule } from "../shared/command-allowlist.ts";
import { writeFileAtomic } from "./atomic.ts";
import { redactSecretsInText } from "./redact.ts";

const MAX_COMMAND_BYTES = 16_384;
const MAX_CWD_BYTES = 4_096;
const MAX_RULES_PER_BOT = 200;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const BOT_ID = /^[\w-]{1,128}$/;
const RULE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type StoredRule = CommandAllowlistRule & { botId: string };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (message: string): Error => Object.assign(new Error(message), { status: 400 });

/** Validate without rewriting the command. Resolving a symlink, or folding
 * `..` across one, could make a grant apply in a different directory. */
export function validateCommandAllowlistCandidate(value: unknown): CommandAllowlistCandidate {
  if (!record(value)) throw invalid("A command, absolute working directory and engine instance are required.");
  const { command, cwd, providerInstanceId } = value;
  if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command) > MAX_COMMAND_BYTES ||
    /[\p{Cc}\p{Cs}]/u.test(command.replace(/[\t\r\n]/g, ""))) {
    throw invalid("The command must be nonempty text of at most 16384 bytes, without invalid control characters.");
  }
  if (redactSecretsInText(command) !== command) {
    throw invalid("Commands containing credentials cannot be saved. Use an environment variable instead.");
  }
  if (typeof cwd !== "string" || !cwd || Buffer.byteLength(cwd) > MAX_CWD_BYTES ||
    /[\p{Cc}\p{Cs}]/u.test(cwd) || !isAbsolute(cwd) || cwd.split(sep === "\\" ? /[\\/]/ : /\//).includes("..")) {
    throw invalid("The working directory must be an absolute path without parent-directory segments.");
  }
  // On Windows, `\work` is rooted but still depends on the current drive.
  if (process.platform === "win32" && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(cwd)) {
    throw invalid("The working directory must include its drive or network share.");
  }
  if (typeof providerInstanceId !== "string" || !providerInstanceId || providerInstanceId.trim() !== providerInstanceId ||
    providerInstanceId.length > 200 || /[\p{Cc}\p{Cs}]/u.test(providerInstanceId)) {
    throw invalid("A valid engine instance is required.");
  }
  // Keep directory spelling exact too. A false negative is preferable to
  // treating two paths as equivalent without knowing the engine's filesystem.
  return { command, cwd, providerInstanceId };
}

/** Runtime metadata that cannot identify an exact scope never auto-allows. */
export function commandAllowlistCandidate(value: unknown): CommandAllowlistCandidate | null {
  try { return validateCommandAllowlistCandidate(value); } catch { return null; }
}

function validateBotId(botId: string): void {
  if (typeof botId !== "string" || !BOT_ID.test(botId)) throw invalid("A valid bot id is required.");
}

function sameScope(left: CommandAllowlistCandidate, right: CommandAllowlistCandidate): boolean {
  return left.command === right.command && left.cwd === right.cwd && left.providerInstanceId === right.providerInstanceId;
}

/** Installation-local grants, deliberately separate from bot profiles and
 * templates. Callers must also exclude this file from workspace backups.
 * One server owns the store; a successful atomic save precedes publication. */
export class CommandAllowlistStore {
  private rules: StoredRule[] = [];
  private unreadable = false;
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new Error("Invalid command rule store.");
      const saved: unknown = JSON.parse(readFileSync(filename, "utf8"));
      if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.rules) ||
        Object.keys(saved).some((key) => key !== "version" && key !== "rules")) throw new Error("Invalid command rule store.");
      const rules: StoredRule[] = [];
      const ids = new Set<string>();
      const counts = new Map<string, number>();
      for (const row of saved.rules) {
        if (!record(row) || typeof row.id !== "string" || !RULE_ID.test(row.id) || ids.has(row.id) ||
          typeof row.botId !== "string" || Object.keys(row).some((key) => !["id", "botId", "command", "cwd", "providerInstanceId"].includes(key))) {
          throw new Error("Invalid command rule store.");
        }
        validateBotId(row.botId);
        const candidate = validateCommandAllowlistCandidate(row);
        const count = (counts.get(row.botId) ?? 0) + 1;
        if (count > MAX_RULES_PER_BOT) throw new Error("Too many saved command rules.");
        counts.set(row.botId, count);
        ids.add(row.id);
        rules.push({ ...candidate, id: row.id, botId: row.botId });
      }
      this.rules = rules;
    } catch (error) {
      // Missing means no grants. Any other read/validation failure disables
      // all grants and forbids overwriting evidence of a damaged store.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unreadable = true;
    }
  }

  list(botId: string): CommandAllowlistRule[] {
    validateBotId(botId);
    return this.rules.filter((rule) => rule.botId === botId).map(({ botId: _botId, ...rule }) => rule);
  }

  add(botId: string, value: CommandAllowlistCandidate): CommandAllowlistRule {
    this.assertWritable();
    validateBotId(botId);
    const candidate = validateCommandAllowlistCandidate(value);
    const existing = this.list(botId);
    const duplicate = existing.find((rule) => sameScope(rule, candidate));
    if (duplicate) return duplicate;
    if (existing.length >= MAX_RULES_PER_BOT) throw invalid("A bot may save at most 200 commands.");
    const rule = { ...candidate, id: randomUUID() };
    this.save([...this.rules, { ...rule, botId }]);
    return rule;
  }

  remove(botId: string, ruleId: string): boolean {
    this.assertWritable();
    validateBotId(botId);
    const next = this.rules.filter((rule) => rule.botId !== botId || rule.id !== ruleId);
    if (next.length === this.rules.length) return false;
    this.save(next);
    return true;
  }

  clear(botId: string): void {
    this.assertWritable();
    validateBotId(botId);
    const next = this.rules.filter((rule) => rule.botId !== botId);
    if (next.length !== this.rules.length) this.save(next);
  }

  matches(botId: string, value: CommandAllowlistCandidate): boolean {
    if (this.unreadable || typeof botId !== "string" || !BOT_ID.test(botId)) return false;
    const candidate = commandAllowlistCandidate(value);
    return candidate !== null && this.rules.some((rule) => rule.botId === botId && sameScope(rule, candidate));
  }

  private assertWritable(): void {
    if (this.unreadable) throw Object.assign(new Error("Saved command rules could not be read. Repair the rule store before changing them."), { status: 503 });
  }

  private save(rules: StoredRule[]): void {
    const json = JSON.stringify({ version: 1, rules }, null, 2);
    if (Buffer.byteLength(json) > MAX_STORE_BYTES) throw invalid("The saved command rules exceed the storage limit.");
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.filename, json, { mode: 0o600 });
    this.rules = rules;
  }
}
