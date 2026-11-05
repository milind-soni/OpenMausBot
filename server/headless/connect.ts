// The token is written to a file only you can read and never printed: pass the file to other verbs with --token-file.
import { closeSync, existsSync, fchmodSync, fstatSync, openSync, writeSync } from "node:fs";
import { isatty } from "node:tty";

import { EXIT, flag, HeadlessError, usageError } from "./args.ts";
import { loadMcp, namedServer } from "./client.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";

type Rec = Record<string, any>;

const isLoopback = (origin: string) => /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(origin);

async function call(origin: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: Rec }> {
  const response = await fetch(`${origin}${path}`, {
    ...init, redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", "x-openmausbot-cli": "1", ...(init.headers as Record<string, string> | undefined) },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Rec };
}

/** A new file only this user can read; never a terminal. */
export function writeTokenFile(path: string, token: string, force: boolean): void {
  if (path === "-" || /^\/dev\/(?:stdout|stderr|tty)$/.test(path)) throw usageError("the token goes to a file, never to the terminal", "pass --out FILE");
  if (existsSync(path) && !force) throw usageError(`${path} already exists`, "pass --force to replace it");
  const fd = openSync(path, force ? "w" : "wx", 0o600);
  try {
    if (isatty(fd) || fstatSync(fd).isCharacterDevice()) throw usageError("the token goes to a file, never to the terminal", "pass --out FILE");
    // a file being replaced keeps its old mode unless told
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
}

export async function connectVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const out = flag(ctx.flags, "out")?.trim();
  if (!out) throw usageError("--out FILE is required: where to keep the token");
  const mcp = await loadMcp();
  const named = ctx.positionals[0]?.trim() ? { url: ctx.positionals[0]!.trim() } : namedServer(ctx.flags, ctx.env) ?? { port: "8799" };
  let origin: string;
  try {
    origin = "url" in named ? mcp.validateBaseUrl(named.url) : mcp.validateBaseUrl(`http://127.0.0.1:${named.port}`);
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  let code = flag(ctx.flags, "code")?.replace(/\s+/g, "");
  if (!code && !isLoopback(origin)) throw usageError("a workspace elsewhere needs a pairing code", "open Settings → Phone → Set up a phone there, then pass --code CODE");
  const unreachable = () => new HeadlessError(`no OpenMausBot server answers at ${origin}`, EXIT.unreachable, "check the address, and that the server is running");
  const described = await call(origin, "/.well-known/openmausbot/environment").catch(() => { throw unreachable(); });
  if (described.status !== 200 || typeof described.body.environmentId !== "string") throw unreachable();
  const label = flag(ctx.flags, "label")?.trim() || "openmausbot CLI";
  if (!code) {
    const minted = await call(origin, "/api/auth/pairing", { method: "POST", body: JSON.stringify({ label, ...(ctx.flags.client ? { scopes: ["client"] } : {}) }) });
    if (minted.status !== 200 || typeof minted.body.code !== "string") {
      throw new HeadlessError(`this server will not mint a pairing code for a command on this computer${minted.body.error ? ` (${minted.body.error})` : ""}`,
        EXIT.unreachable, "pair from Settings → Phone → Set up a phone in the app, then pass --code CODE");
    }
    code = minted.body.code;
  }
  const paired = await call(origin, "/api/auth/pair", { method: "POST", body: JSON.stringify({ code, label }) });
  if (paired.status !== 200 || typeof paired.body.token !== "string") {
    throw new HeadlessError(`the code was not accepted${paired.body.error ? `: ${paired.body.error}` : ""}`, EXIT.unreachable, "codes are single use and expire (after five minutes, unless made with openmausbot pair --ttl): get a new one");
  }
  writeTokenFile(out, paired.body.token, ctx.flags.force === true);
  const session = paired.body.session ?? {};
  const environment = paired.body.environment ?? described.body;
  const scope = Array.isArray(session.scopes) && session.scopes.includes("admin") ? "admin" : "client";
  return {
    result: {
      ok: true, url: origin, tokenFile: out,
      workspace: { label: environment.label, environmentId: environment.environmentId, version: environment.version },
      session: { id: session.id, label: session.label, scopes: session.scopes, expiresAt: session.expiresAt },
    },
    exitCode: EXIT.done,
    human: [
      `Connected to "${environment.label}" (${origin}, id ${environment.environmentId}).`,
      `Session "${session.label ?? label}", ${scope === "admin" ? "full access" : "chat and approvals only"}${typeof session.expiresAt === "number" ? `, until ${new Date(session.expiresAt).toISOString().slice(0, 10)}` : ""}.`,
      `Token saved to ${out}. Use it with: openmausbot doctor --url ${origin} --token-file ${out}`,
    ],
  };
}
