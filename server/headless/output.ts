// With --json, stdout carries exactly one JSON document, errors included ({ ok: false, error, hint, exitCode }); progress
// goes to stderr, dropped by --quiet. Every printed string passes through the transcript's secret redaction.
import { redactSecretsInText } from "../../shared/redact.ts";
import type { HeadlessError } from "./args.ts";

export interface HeadlessIo {
  out(text: string): void;
  err(text: string): void;
  readStdin(): Promise<string>;
}

export function processIo(): HeadlessIo {
  return {
    out: (text) => { process.stdout.write(`${text}\n`); },
    err: (text) => { process.stderr.write(`${text}\n`); },
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecretsInText(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)])) as T;
  }
  return value;
}

export class Output {
  readonly json: boolean;
  readonly quiet: boolean;
  private readonly io: HeadlessIo;

  constructor(io: HeadlessIo, mode: { json?: boolean; quiet?: boolean }) {
    this.io = io;
    this.json = mode.json === true;
    this.quiet = mode.quiet === true;
  }

  progress(event: Record<string, unknown>): void {
    if (!this.quiet) this.io.err(JSON.stringify(redactDeep(event)));
  }

  result(value: unknown, human: readonly string[]): void {
    if (this.json) this.io.out(JSON.stringify(redactDeep(value), null, 2));
    else for (const line of human) this.io.out(redactSecretsInText(line));
  }

  error(error: HeadlessError): void {
    const body = { ok: false, error: error.message, ...(error.hint ? { hint: error.hint } : {}), exitCode: error.exitCode };
    if (this.json) this.io.out(JSON.stringify(redactDeep(body), null, 2));
    else {
      this.io.err(redactSecretsInText(`error: ${error.message}`));
      if (error.hint) this.io.err(redactSecretsInText(`hint: ${error.hint}`));
    }
  }
}

export const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

export const oneLine = (text: string, max = 120): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
