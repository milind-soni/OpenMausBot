// An access token is a session made for a script: it ends on its date and never renews. It is listed and revoked like
// any session, and, like `connect`'s, written to a file only you can read and never printed.
import { existsSync } from "node:fs";

import { EXIT, flag, HeadlessError, oneOf, parseDuration, usageError } from "./args.ts";
import { writeTokenFile } from "./connect.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";

type Rec = Record<string, any>;

const DAY = 24 * 3_600_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const scopeOf = (session: Rec) => (Array.isArray(session.scopes) && session.scopes.includes("admin") ? "admin" : "client");

async function tokens(ctx: VerbContext): Promise<Rec[]> {
  const listed = await (await ctx.client()).json<Rec>("/api/auth/sessions");
  return (Array.isArray(listed.sessions) ? listed.sessions : []).filter((session: Rec) => session.token === true);
}

async function create(ctx: VerbContext): Promise<VerbOutcome> {
  const name = ctx.positionals[0]?.trim();
  if (!name) throw usageError("name the token", "openmausbot token create NAME --out FILE [--scope client|admin] [--expires 90d]");
  const out = flag(ctx.flags, "out")?.trim();
  if (!out) throw usageError("--out FILE is required: where to keep the token");
  if (existsSync(out) && ctx.flags.force !== true) throw usageError(`${out} already exists`, "pass --force to replace it");
  const scope = oneOf(flag(ctx.flags, "scope"), "--scope", ["client", "admin"] as const, "client");
  const raw = flag(ctx.flags, "expires");
  const ttlMs = raw ? parseDuration(raw, "--expires", { min: 3_600_000, max: 3_650 * DAY }) : 90 * DAY;
  const client = await ctx.client();
  const minted = await client.json<Rec>("/api/auth/pairing", {
    method: "POST", body: JSON.stringify({ label: name, scopes: scope === "admin" ? ["admin", "client"] : ["client"], tokenTtlMs: ttlMs }),
  });
  const paired = await client.json<Rec>("/api/auth/pair", { method: "POST", body: JSON.stringify({ code: minted.code, label: name }) });
  const session: Rec = paired.session ?? {};
  if (session.token !== true) {
    // A server from before tokens opened an ordinary session that renews itself: end it rather than hand it out.
    if (typeof session.id === "string") await client.json(`/api/auth/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" }).catch(() => undefined);
    throw new HeadlessError("this OpenMausBot server cannot make access tokens", EXIT.unreachable, "update OpenMausBot on the server, or use openmausbot connect");
  }
  writeTokenFile(out, paired.token, ctx.flags.force === true);
  return {
    result: { ok: true, tokenFile: out, url: client.baseUrl, token: { id: session.id, name: session.label, scope, expiresAt: session.expiresAt } },
    exitCode: EXIT.done,
    human: [
      `Token "${session.label}" (${scope === "admin" ? "full access" : "chat and approvals only"}) until ${day(session.expiresAt)}, id ${session.id}.`,
      `Saved to ${out}. Use it with: openmausbot ${scope === "admin" ? "doctor" : "bots"} --url ${client.baseUrl} --token-file ${out}`,
      `Revoke it with: openmausbot token revoke ${session.id}`,
    ],
  };
}

async function list(ctx: VerbContext): Promise<VerbOutcome> {
  const found = (await tokens(ctx)).map((session) => ({ id: session.id, name: session.label, scope: scopeOf(session), createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt }));
  return {
    result: { tokens: found }, exitCode: EXIT.done,
    human: found.length
      ? found.map((token) => `${token.name} · ${token.scope} · until ${day(token.expiresAt)} · last used ${day(token.lastSeenAt)} · id ${token.id}`)
      : ["No access tokens. Make one with: openmausbot token create NAME --out FILE"],
  };
}

async function revoke(ctx: VerbContext): Promise<VerbOutcome> {
  const id = ctx.positionals[0]?.trim();
  if (!id) throw usageError("give the token's id", "openmausbot token list shows them");
  const token = (await tokens(ctx)).find((session) => session.id === id);
  if (!token) throw new HeadlessError(`no access token with id ${id}`, EXIT.failed, "openmausbot token list shows them; a device's session is revoked with openmausbot sessions revoke ID");
  await (await ctx.client()).json(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  return { result: { ok: true, revoked: { id, name: token.label } }, exitCode: EXIT.done, human: [`Revoked "${token.label}" (${id}): it no longer works.`] };
}

export function tokenVerb(ctx: VerbContext): Promise<VerbOutcome> {
  return ctx.verb === "token create" ? create(ctx) : ctx.verb === "token list" ? list(ctx) : revoke(ctx);
}
