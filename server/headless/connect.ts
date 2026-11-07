// The token is written to a file only you can read and never printed: pass the file to other verbs with --token-file.
import { closeSync, existsSync, fchmodSync, fstatSync, openSync, writeSync } from "node:fs";
import { isatty } from "node:tty";

import { parseServerInput } from "../../electron/server-address.mjs";
import { cliCommand } from "../cli-invocation.ts";
import { EXIT, flag, HeadlessError, usageError } from "./args.ts";
import { namedServer } from "./client.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";

type Rec = Record<string, any>;

/** The command that makes a pairing code on a server, whichever way that server was installed. */
const PAIR_ON_SERVER = "npx openmausbot pair (Docker: docker compose exec omb node dist-server/openmausbot.js pair)";

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

const PROBLEM: Record<string, string> = {
  empty: "give the server's address or its pairing link",
  codeOnly: "that is a pairing code: give the server's address too, like openmausbot connect http://192.168.1.20:8799 --code CODE",
  emailCode: "that is a sign-in code from an email; pairing needs a 12-character code like 7KQ2-M9XD-H4TP",
  oldCode: "that is a code from an older MausBot; pairing needs a 12-character code like 7KQ2-M9XD-H4TP",
  scriptKey: "that is a script key; pass it with --token-file instead of pairing",
  notACode: "that is not a pairing code; pairing needs a 12-character code like 7KQ2-M9XD-H4TP",
  phoneLink: "that link is for the MausBot phone app; give the server's address or the link the server printed",
  notAnAddress: "that is not a server address; give the link the server printed, or its address like http://192.168.1.20:8799",
};

function target(ctx: VerbContext): { candidates: string[]; secret: string | null } {
  const typedCode = flag(ctx.flags, "code")?.trim() ?? "";
  const positional = ctx.positionals[0]?.trim();
  const named = positional ? { url: positional } : namedServer(ctx.flags, ctx.env) ?? { port: "8799" };
  const read = parseServerInput("url" in named ? named.url : `http://127.0.0.1:${named.port}`, typedCode);
  if (read.ok) return { candidates: read.candidates, secret: read.code ?? read.credential };
  if (read.problem === "publicHttp") {
    throw usageError(`http://${read.host} is on the open internet and plain http isn't encrypted`, "use the server's https:// address, or put HTTPS in front (cloudflared, Caddy or Tailscale)");
  }
  throw usageError(PROBLEM[read.problem] ?? PROBLEM.notAnAddress!);
}

export async function connectVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const out = flag(ctx.flags, "out")?.trim();
  if (!out) throw usageError("--out FILE is required: where to keep the script key");
  const { candidates, secret } = target(ctx);
  let origin = candidates[0]!;
  let described: { status: number; body: Rec } | null = null;
  for (const candidate of candidates) {
    described = await call(candidate, "/.well-known/openmausbot/environment").catch(() => null);
    origin = candidate;
    if (described?.status === 200 && typeof described.body.environmentId === "string") break;
  }
  const pairHint = `make a code on the server: ${PAIR_ON_SERVER}, then pass --code CODE`;
  let code = secret;
  if (!code && !isLoopback(origin)) throw usageError("a workspace elsewhere needs a pairing code", pairHint);
  if (described?.status !== 200 || typeof described.body.environmentId !== "string") {
    throw new HeadlessError(`no MausBot server answers at ${origin}`, EXIT.unreachable, "check the address, and that the server is running with a way in (see openmausbot serve --help on the server)");
  }
  const label = flag(ctx.flags, "label")?.trim() || "openmausbot CLI";
  if (!code) {
    const minted = await call(origin, "/api/auth/pairing", { method: "POST", body: JSON.stringify({ label, ...(ctx.flags.client ? { scopes: ["client"] } : {}) }) });
    if (minted.status !== 200 || typeof minted.body.code !== "string") {
      throw new HeadlessError(`this server will not mint a pairing code for a command on this computer${minted.body.error ? ` (${minted.body.error})` : ""}`,
        EXIT.unreachable, `${cliCommand("pair")} in a terminal on this computer, then pass --code CODE`);
    }
    code = minted.body.code as string;
  }
  const paired = await call(origin, "/api/auth/pair", { method: "POST", body: JSON.stringify({ code, label }) });
  if (paired.status !== 200 || typeof paired.body.token !== "string") {
    throw new HeadlessError(`the code was not accepted${paired.body.error ? `: ${paired.body.error}` : ""}`, EXIT.unreachable, `codes work once and run out: ${pairHint}`);
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
      `Connected to "${environment.label}" (${origin}, ${scope === "admin" ? "everything" : "chat and approvals"}${typeof session.expiresAt === "number" ? `, until ${new Date(session.expiresAt).toISOString().slice(0, 10)}` : ""}).`,
      `Script key saved to ${out}. Check it: ${cliCommand(`doctor --url ${origin} --token-file ${out}`)}`,
    ],
  };
}
