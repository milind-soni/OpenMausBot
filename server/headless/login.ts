// login, logout, whoami, use and servers. The session goes to the Keychain (or a file only you can read) and is never
// printed or taken on the command line; it is sent only to the exact address it was made at.
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";

import { EXIT, flag, HeadlessError, oneOf, usageError } from "./args.ts";
import { BOT_SHELL_HINT, BOT_SHELL_REFUSAL } from "./bot-shell.ts";
import { loadMcp, namedServer } from "./client.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";
import type { SavedServer, SavedServers } from "./saved-servers.ts";

type Rec = Record<string, any>;

const DISCOVERY_PORTS = [8799, 18799, 28799];
const LOOPBACK = /^https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?$/i;

/** The desktop app runs this server: it shows the Allow card itself, and its local changes need a sign-in. */
const desktopApp = (environment: Rec) => environment.capabilities?.selfUpdate === "desktop-managed";
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const reach = (scopes: readonly string[]) => (scopes.includes("admin") ? "full control" : "chat only");

function savedOnly(ctx: VerbContext): SavedServers {
  if (ctx.botShell || !ctx.saved) throw new HeadlessError(BOT_SHELL_REFUSAL, EXIT.notAllowed, BOT_SHELL_HINT);
  return ctx.saved;
}

async function call(origin: string, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<{ status: number; body: Rec }> {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(`${origin}${path}`, {
    ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Rec };
}

/** `maus.example.com` is https, `localhost:8799` http: the address a person types, as an origin. */
function typedOrigin(typed: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `${/^(?:localhost|127\.|\[::1\])/i.test(typed) ? "http" : "https"}://${typed}`;
  return withScheme.replace(/\/+$/, "");
}

async function serverToSignInTo(ctx: VerbContext): Promise<string> {
  const mcp = await loadMcp();
  const valid = (url: string) => {
    try {
      return mcp.validateBaseUrl(url);
    } catch (error) {
      throw usageError(error instanceof Error ? error.message : String(error));
    }
  };
  const typed = ctx.positionals[0]?.trim();
  if (typed) return valid(typedOrigin(typed));
  const named = namedServer(ctx.flags, ctx.env);
  if (named) return valid("url" in named ? named.url : `http://127.0.0.1:${named.port}`);
  try {
    return await mcp.probeBaseUrls(DISCOVERY_PORTS.map((port) => `http://127.0.0.1:${port}`));
  } catch {
    throw new HeadlessError("MausBot is not running on this computer", EXIT.unreachable,
      "open the MausBot app, or name a server: openmausbot login https://maus.example.com (an OpenMausBot account for --tunnel is openmausbot account login)");
  }
}

/** `local` for this computer's usual port, `local-18799` for another, else the host's name. */
export function defaultServerName(origin: string): string {
  const url = new URL(origin);
  if (LOOPBACK.test(origin)) return !url.port || url.port === "8799" ? "local" : `local-${url.port}`;
  return url.hostname.replace(/[^\w.-]/g, "-").slice(0, 80);
}

/** A server run by `openmausbot serve` with owner trust makes a code for a program on its own computer, as `connect` does. */
async function signInDirectly(origin: string, label: string, scopes: string[], signal: AbortSignal): Promise<Rec | null> {
  const minted = await call(origin, "/api/auth/pairing", { method: "POST", body: JSON.stringify({ label, scopes }) }, signal);
  if (minted.status !== 200 || typeof minted.body.code !== "string") return null;
  const paired = await call(origin, "/api/auth/pair", { method: "POST", body: JSON.stringify({ code: minted.body.code, label }) }, signal);
  return paired.status === 200 && typeof paired.body.token === "string" ? paired.body : null;
}

async function signInWithCard(ctx: VerbContext, origin: string, label: string, scope: "admin" | "client", environment: Rec): Promise<Rec> {
  const verifier = randomBytes(32).toString("base64url");
  const verifierHash = createHash("sha256").update(verifier).digest("base64url");
  const started = await call(origin, "/api/auth/cli-login", { method: "POST", body: JSON.stringify({ label, scope, verifierHash }) }, ctx.signal);
  if (started.status === 404) {
    throw new HeadlessError("this server does not take openmausbot login yet", EXIT.failed, "update MausBot there, or use openmausbot connect URL --code CODE --out FILE");
  }
  if (started.status !== 201 || typeof started.body.id !== "string") {
    throw new HeadlessError(`the server would not start a sign-in: ${started.body.error ?? started.status}`, started.status === 403 ? EXIT.notAllowed : EXIT.failed);
  }
  const code = String(started.body.code);
  if (desktopApp(environment) && LOOPBACK.test(origin)) {
    ctx.io.err(`MausBot is asking you to allow this terminal. Check the code in the app matches, then press Allow:\n\n    ${code}\n`);
  } else {
    const opened = await ctx.openBrowser(`${origin}/`);
    ctx.io.err(`${opened ? "Opened" : "Open"} ${origin}/ in your browser. Sign in there if it asks, check the code matches, then press Allow:\n\n    ${code}\n`);
  }
  const until = Number(started.body.expiresAt) || Date.now() + 10 * 60_000;
  const every = Math.min(5_000, Math.max(500, Number(started.body.intervalMs) || 1_000));
  while (Date.now() < until) {
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(new HeadlessError("stopped: nothing was signed in", EXIT.interrupted)); };
      const timer = setTimeout(() => { ctx.signal.removeEventListener("abort", stop); resolve(); }, every);
      ctx.signal.addEventListener("abort", stop, { once: true });
    });
    const polled = await call(origin, `/api/auth/cli-login/${encodeURIComponent(started.body.id)}`, { method: "POST", body: JSON.stringify({ verifier }) }, ctx.signal);
    if (polled.status === 202) continue;
    if (polled.status === 200 && typeof polled.body.token === "string") return polled.body;
    if (polled.body.state === "denied") throw new HeadlessError("the sign-in was denied in MausBot", EXIT.notAllowed);
    throw new HeadlessError(`the sign-in did not finish: ${polled.body.error ?? polled.status}`, polled.status === 403 ? EXIT.notAllowed : EXIT.failed,
      "run openmausbot login again");
  }
  throw new HeadlessError("nobody allowed the sign-in within ten minutes", EXIT.failed, "run openmausbot login again, then press Allow in MausBot");
}

export async function loginVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const saved = savedOnly(ctx);
  const scope = oneOf(flag(ctx.flags, "scope"), "--scope", ["all", "chat"] as const, "all") === "chat" ? "client" : "admin";
  const origin = await serverToSignInTo(ctx);
  const described = await call(origin, "/.well-known/openmausbot/environment", {}, ctx.signal).catch(() => null);
  if (described?.status !== 200 || typeof described.body.environmentId !== "string") {
    throw new HeadlessError(`no MausBot server answers at ${origin}`, EXIT.unreachable, "check the address, and that MausBot is running there");
  }
  const environment = described.body;
  const name = flag(ctx.flags, "name")?.trim() || defaultServerName(origin);
  const label = `openmausbot CLI on ${hostname().slice(0, 50)}`;
  const scopes = scope === "admin" ? ["admin", "client"] : ["client"];
  const direct = LOOPBACK.test(origin) && !desktopApp(environment) ? await signInDirectly(origin, label, scopes, ctx.signal) : null;
  const answer = direct ?? await signInWithCard(ctx, origin, label, scope, environment);
  const session = answer.session ?? {};
  const server: Omit<SavedServer, "store"> = {
    url: origin, environmentId: environment.environmentId, label: String(answer.environment?.label ?? environment.label ?? name),
    sessionId: String(session.id ?? ""), scopes: Array.isArray(session.scopes) ? session.scopes : scopes, expiresAt: Number(session.expiresAt) || 0,
  };
  const store = saved.save(name, server, answer.token as string);
  return {
    result: { ok: true, name, server: { url: origin, label: server.label, environmentId: server.environmentId },
      session: { id: server.sessionId, label: session.label ?? label, scopes: server.scopes, expiresAt: server.expiresAt }, storedIn: store },
    exitCode: EXIT.done,
    human: [
      `Signed in to "${server.label}" (${origin}) with ${reach(server.scopes)}${server.expiresAt ? `, until ${day(server.expiresAt)} (it renews while you use it)` : ""}.`,
      `Saved as "${name}" ${store === "keychain" ? "in the macOS Keychain" : "in a file only you can read"}; it is now the server every command uses.`,
    ],
  };
}

export async function logoutVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const saved = savedOnly(ctx);
  const name = ctx.positionals[0]?.trim() || saved.current()?.name;
  const server = name ? saved.get(name) : null;
  if (!name || !server) {
    if (ctx.positionals[0]) throw new HeadlessError(`no saved server named "${name}"`, EXIT.notFound, "openmausbot servers lists them");
    return { result: { ok: true, signedOut: null }, exitCode: EXIT.done,
      human: ["You are not signed in to any server. (To release a --tunnel address and sign this machine out of its OpenMausBot account: openmausbot account logout.)"] };
  }
  const token = saved.token(name);
  const ended = token
    ? await call(server.url, "/api/auth/logout", { method: "POST", body: "{}", headers: { authorization: `Bearer ${token}` } }).then((answer) => answer.status === 200, () => false)
    : false;
  saved.forget(name);
  return {
    result: { ok: true, signedOut: name, url: server.url, sessionEnded: ended },
    exitCode: EXIT.done,
    human: [`Signed out of "${server.label}" (${server.url}).${ended ? "" : " The server could not be reached, so its session ends on its own date; Settings → Devices removes it now."}`],
  };
}

export async function whoamiVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const client = await ctx.client();
  const [session, environment] = await Promise.all([
    client.json<Rec>("/api/auth/session"),
    client.json<Rec>("/.well-known/openmausbot/environment").catch(() => ({} as Rec)),
  ]);
  const where = `${environment.label ? `"${environment.label}" ` : ""}(${client.baseUrl})`;
  const who = session.kind === "session"
    ? `"${session.label || "unnamed"}" on ${where}: ${reach(session.scopes ?? [])}${typeof session.expiresAt === "number" ? `, until ${day(session.expiresAt)}` : ""}`
    : session.trust === "service" || desktopApp(environment)
      ? `this computer, not signed in, on ${where}: you can look; a change needs openmausbot login`
      : `this computer's owner on ${where}`;
  return {
    result: { ok: true, url: client.baseUrl, server: { label: environment.label, environmentId: environment.environmentId }, botShell: ctx.botShell,
      identity: client.identity.kind === "saved" ? { kind: "saved", name: client.identity.name } : { kind: client.identity.kind }, session },
    exitCode: EXIT.done,
    human: [`${ctx.botShell ? "In this bot's shell, acting as the bot (your saved sign-in is not used): " : "You are "}${who}.`],
  };
}

export async function useVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const saved = savedOnly(ctx);
  const name = ctx.positionals[0]?.trim();
  if (!name) throw usageError("name a saved server", "openmausbot servers lists them");
  saved.use(name);
  const server = saved.get(name)!;
  return { result: { ok: true, current: name, url: server.url }, exitCode: EXIT.done, human: [`Every command now goes to "${server.label}" (${server.url}).`] };
}

export async function serversVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const { current, servers } = savedOnly(ctx).list();
  const rows = servers.map(({ store: _store, sessionId: _session, ...server }) => ({ ...server, current: server.name === current }));
  return {
    result: { current, servers: rows },
    exitCode: EXIT.done,
    human: rows.length
      ? rows.map((server) => `${server.current ? "*" : " "} ${server.name}  ${server.url}  "${server.label}"  ${reach(server.scopes)}${server.expiresAt ? `, until ${day(server.expiresAt)}` : ""}`)
      : ["No saved servers. Sign in with: openmausbot login [SERVER]"],
  };
}
