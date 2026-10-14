#!/usr/bin/env node
// As a script: `node --experimental-strip-types server/testing/fake-control-plane.ts [port] [log.jsonl]`.
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export interface FakeRelayRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  /** The raw request body, exactly as the harness sent it. */
  raw: string;
  body: Record<string, unknown> | null;
  status: number;
}

export interface FakeControlPlane {
  url: string;
  /** A credential this fake accepts (any well-formed one is accepted). */
  credential: string;
  requests: FakeRelayRequest[];
  /** tokens registered, per credential */
  registered(credential?: string): string[];
  /** The next answer to a matching path, instead of the normal one. */
  answerNext(path: string, status: number, body: Record<string, unknown>, headers?: Record<string, string>): void;
  /** Forget a registration as if the relay lost it. */
  drop(token: string): void;
  /** Resolves with the first request (already received or not) that matches. */
  waitFor(match: (request: FakeRelayRequest) => boolean): Promise<FakeRelayRequest>;
  stop(): Promise<void>;
}

const CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

export function newInstallationCredential(): string {
  return `omb_install_${randomBytes(16).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
}

export async function startFakeControlPlane(options: { port?: number; log?: string } = {}): Promise<FakeControlPlane> {
  const requests: FakeRelayRequest[] = [];
  const tokens = new Map<string, Set<string>>();
  const scripted: Array<{ path: string; status: number; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const waiters: Array<{ match: (request: FakeRelayRequest) => boolean; resolve: (request: FakeRelayRequest) => void }> = [];
  const credential = newInstallationCredential();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        body = null;
      }
      const path = (req.url ?? "").split("?")[0]!;
      const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
      const reply = (status: number, payload: Record<string, unknown> | null, headers: Record<string, string> = {}) => {
        const record: FakeRelayRequest = { method: req.method ?? "", path, authorization: req.headers.authorization, raw, body, status };
        requests.push(record);
        if (options.log) appendFileSync(options.log, `${JSON.stringify({ at: new Date().toISOString(), ...record, authorization: record.authorization ? "Bearer <redacted>" : undefined })}\n`);
        const matched = waiters.filter((waiter) => waiter.match(record));
        for (const waiter of matched) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(record);
        }
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(payload === null ? "" : JSON.stringify(payload));
      };
      const next = scripted.findIndex((entry) => entry.path === path);
      if (next >= 0) {
        const [entry] = scripted.splice(next, 1);
        return reply(entry!.status, entry!.body, entry!.headers);
      }
      if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
      if (!bearer || !CREDENTIAL.test(bearer)) return reply(401, { error: "unauthorized" });
      const token = typeof body?.token === "string" ? body.token : "";
      if (body?.v !== 1 || !/^[0-9a-f]{64,200}$/.test(token)) return reply(400, { error: "invalid_request" });
      const mine = tokens.get(bearer) ?? new Set<string>();
      tokens.set(bearer, mine);
      if (path === "/v1/installations/self/push/register") {
        mine.add(token);
        return reply(200, { registered: true });
      }
      if (path === "/v1/installations/self/push/unregister") {
        mine.delete(token);
        return reply(204, null);
      }
      if (path === "/v1/installations/self/push/send") {
        if (!mine.has(token)) return reply(404, { error: "push_device_unknown" });
        return reply(202, { sent: true });
      }
      return reply(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    credential,
    requests,
    registered: (presented = credential) => [...(tokens.get(presented) ?? [])],
    answerNext: (path, status, body, headers = {}) => {
      scripted.push({ path, status, body, headers });
    },
    drop: (token) => {
      for (const set of tokens.values()) set.delete(token);
    },
    waitFor: (match) => {
      const seen = requests.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
    stop: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeControlPlane({ port: Number(process.argv[2]) || 0, ...(process.argv[3] ? { log: process.argv[3] } : {}) });
  process.stdout.write(`${JSON.stringify({ url: fake.url, credential: fake.credential })}\n`);
}
