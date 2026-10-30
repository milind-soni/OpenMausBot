// Values a person typed into a bot's card for a secret OpenMausBot does not keep itself.
// Security: a `ref` value stays in this process's memory, behind a one-use reference bound to the asking bot and
// conversation that only OpenMausBot's own tools accept. A `file` value goes to an owner-only file in a private folder
// of that bot's own workspace (or the Local VM workspace its turn runs in); nothing that syncs, backs up, moves, links,
// attaches, publishes or uploads workspace files carries that folder (inSecretFolder). Neither value is ever logged,
// and while either lives, held-secret redaction masks it in transcripts, events and logs.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

import { secretForms } from "./login-store.ts";
import { HELD_SECRET_MASK } from "./redact.ts";
import { inSecretFolder, SECRET_FOLDER } from "./secret-folder.ts";

export { inSecretFolder, SECRET_FOLDER };
/** From saving: room for a resume queued behind other work and the tool call after it, short enough that a ref the bot
 * never used is soon gone. A restart forgets every unused ref. */
export const SECRET_REF_TTL_MS = 60 * 60 * 1000;
export const SECRET_FILE_TTL_MS = 24 * 60 * 60 * 1000;
export const SECRET_VALUE_MAX_BYTES = 4_096;

const REF = /secret-ref:[0-9a-f]{32}/g;
const ID = /^[\w-]{1,128}$/;
const HELD_LIMIT = 200;

export interface SecretOwner {
  botId: string;
  threadId: string;
}

/** The folder that holds SECRET_FOLDER: its path on this computer, and the path the bot's commands use for it. */
export interface SecretFileHome {
  host: string;
  shown: string;
}

export type SavedSecret = { ref: string } | { file: string };

type RefEntry = { owner: SecretOwner; label: string; value: string; expiresAt: number };

export type RedeemResult<T> = { ok: true; value: T; commit(): void } | { ok: false; error: string };

function sameOwner(a: SecretOwner, b: SecretOwner): boolean {
  return a.botId === b.botId && a.threadId === b.threadId;
}

/** Security: the bot can write in its own folder, so a link planted here could send the value wherever it points. */
function privateFolder(path: string, create: "one" | "all"): void {
  try {
    mkdirSync(path, { mode: 0o700, recursive: create === "all" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("the private secrets folder is not a plain folder");
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("the private secrets folder belongs to someone else");
  if ((info.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

function refText(ref: string, reason: "unknown" | "used" | "expired" | "owner"): string {
  switch (reason) {
    case "used":
      return `${ref} was already used: each secretRef works once. Ask again with request_credential.`;
    case "expired":
      return `${ref} expired: a secretRef lasts an hour after the person saves it. Ask again with request_credential.`;
    case "owner":
      return `${ref} was given to another bot or conversation. Ask the person here with request_credential.`;
    default:
      return `${ref} is not a secretRef OpenMausBot holds: it is mistyped, or OpenMausBot restarted before it was used. Ask again with request_credential.`;
  }
}

export const NOT_A_REF_TEXT =
  "That is a secret file for your own commands, not a secretRef: it is deleted after 24 hours, and OpenMausBot's tools take only a secretRef. Ask again with request_credential and delivery ref.";

export class SecretVault {
  private readonly refs = new Map<string, RefEntry>();
  private readonly used = new Map<string, number>();
  private readonly byCard = new Map<string, { ref: string } | { file: string; until: number }>();
  private held: Array<{ forms: string[]; until: number }> = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The card's value behind a new one-use ref; the same card saved again keeps its first ref. */
  saveRef(owner: SecretOwner, messageId: string, label: string, value: string): string {
    const existing = this.savedFor(messageId);
    if (existing && "ref" in existing) return existing.ref;
    const ref = `secret-ref:${randomBytes(16).toString("hex")}`;
    const now = this.now();
    this.refs.set(ref, { owner: { ...owner }, label, value, expiresAt: now + SECRET_REF_TTL_MS });
    this.byCard.set(messageId, { ref });
    this.hold(value, now + SECRET_FILE_TTL_MS);
    return ref;
  }

  /** Writes the card's value to `<home>/.openmausbot-secrets/<thread>/<card>` (0600, in 0700 folders); returns its path
   * as the bot's commands see it. */
  saveFile(owner: SecretOwner, messageId: string, value: string, home: SecretFileHome): string {
    if (!ID.test(owner.threadId) || !ID.test(messageId)) throw new Error("invalid conversation or card id");
    privateFolder(home.host, "all");
    const folder = join(home.host, SECRET_FOLDER);
    privateFolder(folder, "one");
    const threadFolder = join(folder, owner.threadId);
    privateFolder(threadFolder, "one");
    const file = join(threadFolder, messageId);
    rmSync(file, { force: true });
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    try {
      writeSync(fd, value);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const shown = home.shown === home.host ? file : [home.shown, SECRET_FOLDER, owner.threadId, messageId].join("/");
    const until = this.now() + SECRET_FILE_TTL_MS;
    this.byCard.set(messageId, { file: shown, until });
    this.hold(value, until);
    return shown;
  }

  /** What this card's save gave the bot, while it still works; null after a restart, its use or its expiry. */
  savedFor(messageId: string): SavedSecret | null {
    const saved = this.byCard.get(messageId);
    if (!saved) return null;
    if ("ref" in saved) {
      const entry = this.refs.get(saved.ref);
      return entry && entry.expiresAt > this.now() ? { ref: saved.ref } : null;
    }
    return saved.until > this.now() ? { file: saved.file } : null;
  }

  /** Swaps every secretRef in `input` for its value: in a string ("Bearer secret-ref:…") or as {"secretRef": "…"}, and
   * only where `allowed(path)` says. Nothing is spent until `commit`, so a refused save can be retried. */
  redeem<T>(input: T, owner: SecretOwner, allowed: (path: readonly string[]) => boolean, where: string): RedeemResult<T> {
    const wanted = new Set<string>();
    let refusal: string | null = null;
    const visit = (value: unknown, path: string[]): void => {
      if (refusal) return;
      if (typeof value === "string") {
        if (inSecretFolder(value)) { refusal = NOT_A_REF_TEXT; return; }
        const found = value.match(REF) ?? [];
        if (found.length && !allowed(path)) { refusal = `A secretRef works only in ${where}.`; return; }
        for (const ref of found) wanted.add(ref);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach((item, index) => visit(item, [...path, String(index)])); return; }
      const ref = refObject(value);
      if (ref !== undefined) {
        if (!allowed(path)) { refusal = `A secretRef works only in ${where}.`; return; }
        if (!new RegExp(`^${REF.source}$`).test(ref)) { refusal = refText(String(ref).slice(0, 80) || "That secretRef", "unknown"); return; }
        wanted.add(ref);
        return;
      }
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    };
    visit(input, []);
    if (refusal) return { ok: false, error: refusal };
    const now = this.now();
    const values = new Map<string, string>();
    for (const ref of wanted) {
      const entry = this.refs.get(ref);
      if (!entry) return { ok: false, error: refText(ref, this.used.has(ref) ? "used" : "unknown") };
      if (entry.expiresAt <= now) {
        this.refs.delete(ref);
        return { ok: false, error: refText(ref, "expired") };
      }
      if (!sameOwner(entry.owner, owner)) return { ok: false, error: refText(ref, "owner") };
      values.set(ref, entry.value);
    }
    const swap = (value: unknown): unknown => {
      if (typeof value === "string") return value.replace(REF, (ref) => values.get(ref) ?? ref);
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(swap);
      const ref = refObject(value);
      if (ref !== undefined) return values.get(ref);
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, swap(child)]));
    };
    return {
      ok: true,
      value: (values.size ? swap(input) : input) as T,
      commit: () => {
        for (const ref of values.keys()) {
          this.refs.delete(ref);
          this.used.set(ref, this.now());
        }
      },
    };
  }

  /** Removes every secret file past its day or whose card is gone, and every value whose conversation is gone.
   * `savedAt` reads the card, so touching a file never keeps it longer. */
  sweep(bases: readonly string[], savedAt: (threadId: string, messageId: string) => number | null, threadExists: (threadId: string) => boolean): void {
    const now = this.now();
    for (const base of bases) {
      const folder = join(base, SECRET_FOLDER);
      let names: string[];
      try {
        const info = lstatSync(folder);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          rmSync(folder, { force: true });
          continue;
        }
        names = readdirSync(folder);
      } catch {
        continue;
      }
      for (const thread of names) {
        const threadFolder = join(folder, thread);
        try {
          const info = lstatSync(threadFolder);
          if (info.isSymbolicLink() || !info.isDirectory() || !ID.test(thread) || !threadExists(thread)) {
            rmSync(threadFolder, { recursive: true, force: true });
            continue;
          }
          for (const card of readdirSync(threadFolder)) {
            const file = join(threadFolder, card);
            const at = ID.test(card) ? savedAt(thread, card) : null;
            if (at === null || now - at >= SECRET_FILE_TTL_MS || !lstatSync(file).isFile()) rmSync(file, { recursive: true, force: true });
          }
          if (readdirSync(threadFolder).length === 0) rmSync(threadFolder, { recursive: true, force: true });
        } catch {
          continue;
        }
      }
    }
    for (const [ref, entry] of this.refs) if (entry.expiresAt <= now || !threadExists(entry.owner.threadId)) this.refs.delete(ref);
    for (const [ref, at] of this.used) if (now - at >= SECRET_FILE_TTL_MS) this.used.delete(ref);
    for (const [card, saved] of this.byCard) if (("until" in saved && saved.until <= now) || ("ref" in saved && !this.refs.has(saved.ref))) this.byCard.delete(card);
    this.held = this.held.filter((entry) => entry.until > now);
  }

  scrub(text: string): string {
    if (!text || this.held.length === 0) return text;
    const now = this.now();
    let out = text;
    for (const entry of this.held) {
      if (entry.until <= now) continue;
      for (const form of entry.forms) if (out.includes(form)) out = out.split(form).join(HELD_SECRET_MASK);
    }
    return out;
  }

  private hold(value: string, until: number): void {
    const forms = secretForms(value).sort((a, b) => b.length - a.length);
    if (!forms.length) return;
    this.held.push({ forms, until });
    if (this.held.length > HELD_LIMIT) this.held.shift();
  }
}

function refObject(value: object): string | undefined {
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "secretRef") return undefined;
  const ref = (value as { secretRef: unknown }).secretRef;
  return typeof ref === "string" ? ref.trim() : "";
}
