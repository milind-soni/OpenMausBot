// What an engine's exit means, in plain words, and the last lines it wrote to stderr with anything secret-shaped masked.
// The one description of an ACP engine's exit: a turn's (host.ts, core.ts) and Antigravity's setup (antigravity-acp.ts).
// Lines are masked as they arrive and only the last few are kept, so no raw sign-in code or key is held.
import { mask, redactSecretsInText } from "../../../shared/redact.ts";

const SIGNAL_WORDS: Partial<Record<NodeJS.Signals, string>> = {
  SIGABRT: "it stopped itself (abort)",
  SIGKILL: "it was killed, often for running out of memory",
  SIGSEGV: "it crashed",
  SIGBUS: "it crashed",
  SIGILL: "it crashed on an instruction this CPU does not have",
  SIGSYS: "it made a system call the sandbox refuses",
  SIGTERM: "it was stopped",
};
/** A wrapper (bubblewrap, a shell) reports a child killed by signal N as exit 128 + N. */
const WRAPPED: Record<number, NodeJS.Signals> = { 132: "SIGILL", 134: "SIGABRT", 135: "SIGBUS", 137: "SIGKILL", 139: "SIGSEGV", 143: "SIGTERM", 159: "SIGSYS" };

export function exitInWords(code: number | null, signal: NodeJS.Signals | null = null): string | null {
  if (signal) return SIGNAL_WORDS[signal] ?? null;
  if (code === 127) return "a program it needs was not found";
  if (code === 126) return "a program it needs could not be run";
  const wrapped = code === null ? undefined : WRAPPED[code];
  return wrapped ? SIGNAL_WORDS[wrapped] ?? null : null;
}

// Beyond shared/redact.ts: what a sign-in prints. A link's query (state, code, PKCE challenge), Google's token and code
// shapes, a value after a secret-sounding name, and any long opaque run.
const LINK_QUERY = /\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi;
const GOOGLE_SHAPES = [/\bya29\.[\w.-]+/g, /\b1\/\/[\w.-]{16,}/g, /\b4\/[\w-]{16,}/g, /\bGOCSPX-[\w-]+/g];
const SECRET_NAME = "(code|state|token|secret|password|passwd|verifier|challenge|credential|cookie|session|key|auth)";
// After `=` a value is masked from four characters (a six-digit code); after a colon, prose like "Error code: ENOENT" stays.
const SECRET_ASSIGNMENT = new RegExp(`\\b${SECRET_NAME}(s?["']?\\s*=\\s*["']?)([^\\s"',;&]{4,})`, "gi");
const SECRET_PAIR = new RegExp(`\\b${SECRET_NAME}(s?["']?\\s*:\\s*["']?)([^\\s"',;&]{8,})`, "gi");
const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const OPAQUE = /[A-Za-z0-9_-]{32,}/g;
const LINE_CHARS = 300;

export function maskDiagnosticLine(line: string): string {
  let out = redactSecretsInText(line);
  out = out.replace(LINK_QUERY, (match: string, link: string) => `${link}?${mask(match.slice(link.length + 1))}`);
  for (const shape of GOOGLE_SHAPES) out = out.replace(shape, (match) => mask(match));
  for (const pair of [SECRET_ASSIGNMENT, SECRET_PAIR]) {
    out = out.replace(pair, (match, name: string, separator: string, value: string) => value.startsWith("«redacted") ? match : `${name}${separator}${mask(value)}`);
  }
  out = out.replace(OPAQUE, (match) => mask(match));
  const trimmed = out.trim();
  return trimmed.length > LINE_CHARS ? `${trimmed.slice(0, LINE_CHARS)}…` : trimmed;
}

/** The last few non-empty stderr lines, masked as each completes. A line longer than `partialChars` is dropped unread to its
 * end, and a private key's lines from BEGIN to END are never kept. */
export class StderrTail {
  #partial = "";
  #lines: string[] = [];
  #droppingLine = false;
  #inKey = false;
  readonly #keep: number;
  readonly #partialChars: number;

  constructor(keep = 3, partialChars = 64 * 1024) {
    this.#keep = keep;
    this.#partialChars = partialChars;
  }

  /** Raw output; whole lines are kept masked. Only a chunk's last few lines can stay, so only they are masked. */
  write(chunk: string): void {
    let text = chunk;
    if (this.#droppingLine) {
      const end = text.indexOf("\n");
      if (end === -1) return;
      this.#droppingLine = false;
      text = text.slice(end + 1);
    }
    const parts = (this.#partial + text).split("\n");
    const rest = parts.pop() ?? "";
    this.#droppingLine = rest.length > this.#partialChars;
    this.#partial = this.#droppingLine ? "" : rest;
    const shown = parts.map((part) => this.#outsideKey(part)).filter((line): line is string => Boolean(line?.trim()));
    for (const line of shown.slice(-this.#keep)) this.#remember(line);
  }

  /** One whole line, already split by the caller. */
  note(line: string): void {
    const shown = this.#outsideKey(line);
    if (shown) this.#remember(shown);
  }

  #outsideKey(line: string): string | null {
    if (this.#inKey) {
      if (KEY_END.test(line)) this.#inKey = false;
      return null;
    }
    if (!KEY_BEGIN.test(line)) return line;
    this.#inKey = !KEY_END.test(line);
    return "-----BEGIN PRIVATE KEY----- «redacted»";
  }

  #remember(line: string): void {
    const masked = maskDiagnosticLine(line.replace(/\r$/u, ""));
    if (!masked) return;
    this.#lines.push(masked);
    if (this.#lines.length > this.#keep) this.#lines.shift();
  }

  /** The unfinished last line counts once the process has closed. */
  flush(): void {
    const rest = this.#partial;
    this.#partial = "";
    if (rest) this.note(rest);
  }

  clear(): void {
    this.#partial = "";
    this.#lines = [];
    this.#droppingLine = false;
    this.#inKey = false;
  }

  get text(): string {
    return this.#lines.join(" | ");
  }
}

/** What follows "<engine> exited <code>": the meaning and the last output, or nothing when neither is known. */
export function exitDetail(code: number | null, signal: NodeJS.Signals | null, tail: string): string {
  const words = exitInWords(code, signal);
  if (words && tail) return `: ${words}. Last output: ${tail}`;
  if (words) return `: ${words}`;
  return tail ? `: ${tail}` : "";
}
