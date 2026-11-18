// `openmausbot login`: a terminal asks, a person allows it in the app (or a browser signed in here), and the terminal
// gets a session. Asking and polling need no session; only Allow, an ordinary admin route behind the auth gate, mints one.
// Security: a request grants nothing by itself. Any program here (a bot's shell too) can ask, so the person and the
// matching code shown in both places are the boundary; asking is capped and every request ends after ten minutes.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { CLI_LOGIN_PATH, type CliLoginWire } from "../../shared/cli-login.ts";
import { json, readBody } from "../harness/http.ts";
import { fromBrowser, isLoopbackHost, isProxied, ownerOrAdmin, requestSource } from "../request-auth.ts";
import { PAIRING_CODE_ALPHABET, type PublicSession, type SessionRegistry } from "../sessions.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const CLI_LOGIN_TTL_MS = 10 * 60_000;
/** How long an allowed session waits for its terminal to collect it before it is revoked unused. */
const UNCOLLECTED_MS = 2 * 60_000;
const MAX_WAITING = 5;
const MAX_WAITING_PER_SOURCE = 2;
const POLL = /^\/api\/auth\/cli-login\/([\w-]{16,64})$/;
const ANSWER = /^\/api\/auth\/cli-login\/([\w-]{16,64})\/(allow|deny)$/;

interface CliLoginRequest extends CliLoginWire {
  verifierHash: Buffer;
  state: "waiting" | "allowed" | "denied" | "failed";
  token?: string;
  session?: PublicSession;
  error?: string;
  answeredAt?: number;
}

export interface CliLoginDeps {
  sessions: Pick<SessionRegistry, "openPairing" | "exchange" | "revoke">;
  /** Why this server takes no terminal sign-in at all (a hosted workspace's portal is its one sign-in), else null. */
  refusal(): string | null;
  /** Why a program on this server's own machine may not ask (where that is a bot's shell, never a person), else null. */
  loopbackRefusal(): string | null;
  environment(): unknown;
  /** The waiting list changed: tell the admins' windows. */
  changed(): void;
  /** A session this route made (a Team Cloud records who signed in). */
  opened?(session: PublicSession): void;
  now?(): number;
}

const startBody = z.object({
  label: z.string().max(200).optional(),
  scope: z.enum(["admin", "client"]).optional(),
  verifierHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
const pollBody = z.object({ verifier: z.string().min(32).max(128) }).strict();

const digest = (value: string) => createHash("sha256").update(value).digest();
const cleanLabel = (value: string | undefined) =>
  (value ?? "").replace(/[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu, "").trim().slice(0, 80) || "openmausbot CLI";

/** Eight symbols from the pairing alphabet, `ABCD-EFGH`: shown in the terminal and on the card, never typed. */
function matchingCode(): string {
  const symbols = Array.from({ length: 8 }, () => PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)]);
  return `${symbols.slice(0, 4).join("")}-${symbols.slice(4).join("")}`;
}

const wire = (request: CliLoginRequest): CliLoginWire => ({
  id: request.id, code: request.code, label: request.label, scopes: [...request.scopes], local: request.local,
  source: request.source, createdAt: request.createdAt, expiresAt: request.expiresAt,
});

export function createCliLogin(deps: CliLoginDeps) {
  const now = deps.now ?? Date.now;
  const requests = new Map<string, CliLoginRequest>();

  const prune = (): boolean => {
    let changed = false;
    for (const [id, request] of requests) {
      const uncollected = request.state === "allowed" && now() - (request.answeredAt ?? 0) > UNCOLLECTED_MS;
      if (uncollected && request.session) deps.sessions.revoke(request.session.id);
      if (uncollected || (request.state !== "allowed" && now() >= request.expiresAt)) {
        requests.delete(id);
        changed ||= request.state === "waiting";
      }
    }
    return changed;
  };
  const waiting = () => {
    if (prune()) deps.changed();
    return [...requests.values()].filter((request) => request.state === "waiting").sort((a, b) => a.createdAt - b.createdAt);
  };

  async function start(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return void json(res, 415, { error: "send the sign-in request as JSON (content-type: application/json)" });
    if (fromBrowser(req)) return void json(res, 403, { error: "a terminal sign-in starts from the openmausbot command, not a web page" });
    const refusal = deps.refusal();
    if (refusal) return void json(res, 403, { error: refusal });
    const local = !isProxied(req) && isLoopbackHost(req.headers.host);
    const localRefusal = local ? deps.loopbackRefusal() : null;
    if (localRefusal) return void json(res, 403, { error: localRefusal });
    const parsed = startBody.safeParse(await readBody(req, 4_096).catch(() => null));
    if (!parsed.success) return void json(res, 400, { error: "send verifierHash (the SHA-256 of a secret only the terminal keeps, base64url), and optionally label and scope (admin or client)" });
    const source = requestSource(req);
    const open = waiting();
    if (open.length >= MAX_WAITING || open.filter((request) => request.source === source).length >= MAX_WAITING_PER_SOURCE) {
      return void json(res, 429, { error: "too many terminal sign-ins are waiting: allow or deny them in MausBot, or wait ten minutes" });
    }
    const at = now();
    const request: CliLoginRequest = {
      id: randomBytes(18).toString("base64url"),
      code: matchingCode(),
      label: cleanLabel(parsed.data.label),
      scopes: parsed.data.scope === "client" ? ["client"] : ["admin", "client"],
      local,
      source,
      createdAt: at,
      expiresAt: at + CLI_LOGIN_TTL_MS,
      verifierHash: Buffer.from(parsed.data.verifierHash, "base64url"),
      state: "waiting",
    };
    requests.set(request.id, request);
    deps.changed();
    json(res, 201, { id: request.id, code: request.code, expiresAt: request.expiresAt, intervalMs: 1_000 });
  }

  async function poll(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return void json(res, 415, { error: "send the poll as JSON (content-type: application/json)" });
    const parsed = pollBody.safeParse(await readBody(req, 1_024).catch(() => null));
    prune();
    const request = requests.get(id);
    const presented = parsed.success ? digest(parsed.data.verifier) : null;
    if (!request || !presented || presented.length !== request.verifierHash.length || !timingSafeEqual(presented, request.verifierHash)) {
      return void json(res, 404, { state: "gone", error: "no such sign-in request: it ended, or was never made here" });
    }
    if (request.state === "waiting") return void json(res, 202, { state: "waiting", expiresAt: request.expiresAt });
    requests.delete(id);
    if (request.state === "allowed") {
      return void json(res, 200, { state: "allowed", token: request.token, session: request.session, environment: deps.environment() });
    }
    json(res, 403, { state: request.state, error: request.state === "denied" ? "the sign-in was denied in MausBot" : request.error ?? "the sign-in could not be completed" });
  }

  /** Before the auth gate: asking and polling, which carry no session. Anything else under the path passes through. */
  async function open(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
    if (method !== "POST") return false;
    if (path === CLI_LOGIN_PATH) {
      await start(req, res);
      return true;
    }
    const polled = POLL.exec(path);
    if (!polled) return false;
    await poll(req, res, polled[1]!);
    return true;
  }

  function allow(request: CliLoginRequest): void {
    let opened: ReturnType<typeof deps.sessions.openPairing>;
    try {
      opened = deps.sessions.openPairing({ scopes: request.scopes, label: request.label });
    } catch (error) {
      request.state = "failed";
      request.error = error instanceof Error ? error.message : String(error);
      return;
    }
    const exchanged = deps.sessions.exchange({ code: opened.credential, label: request.label, source: request.source });
    if (!exchanged.ok) {
      request.state = "failed";
      request.error = exchanged.error;
      return;
    }
    deps.opened?.(exchanged.session);
    Object.assign(request, { state: "allowed", token: exchanged.token, session: exchanged.session, answeredAt: now() });
  }

  const routes: RouteHandler = async ({ res, path, method, auth }) => {
    const answer = ANSWER.exec(path);
    if (path !== CLI_LOGIN_PATH && !answer) return PASS;
    if (!ownerOrAdmin(auth)) return void json(res, 403, { error: "only the owner or an admin allows a terminal" });
    if (!answer) {
      if (method !== "GET") return PASS;
      return void json(res, 200, { requests: waiting().map(wire) });
    }
    if (method !== "POST") return PASS;
    const request = waiting().find((candidate) => candidate.id === answer[1]);
    if (!request) return void json(res, 404, { error: "that sign-in request ended" });
    if (answer[2] === "deny") Object.assign(request, { state: "denied", answeredAt: now() });
    else allow(request);
    deps.changed();
    json(res, request.state === "failed" ? 403 : 200, request.state === "failed" ? { error: request.error } : { ok: true, state: request.state });
  };

  return { open, routes, waiting: () => waiting().map(wire) };
}
