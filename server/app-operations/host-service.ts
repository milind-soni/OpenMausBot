// The one door from app runtimes back into our server. A request counts only with the secret of a running app (added by
// workerd, out of the worker's reach) and a token for an invocation our server itself started for that same app; what the
// invocation may do (read or change, data, connectors) comes from that record, never from the request.
//
// Security: no turn capability is accepted or minted here; outside a model turn the per-app secret and the invocation
// token are the only authority. POSIX: a unix socket in a 0700 folder, so only this user's processes can connect.
// Windows: loopback TCP, which any local process can reach, so the secret is the only thing standing in the way.
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppOperationError } from "./errors.ts";
import { APP_SECRET_HEADER, INVOCATION_HEADER } from "./workerd-config.ts";

export const HOST_BODY_BYTES = 256 * 1024;

export interface HostInvocation {
  handle(path: string, body: Record<string, unknown>): Promise<unknown>;
}

interface AppEntry {
  secretHash: Buffer;
  invocations: Map<string, HostInvocation>;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export class HostService {
  private server: Server | null = null;
  private folder: string | null = null;
  private address: string | null = null;
  private readonly apps = new Map<string, AppEntry>();
  /** Refused requests by reason, for tests and the log. */
  readonly refused: string[] = [];

  /** "unix:/path" or "127.0.0.1:port", for a workerd external service. */
  async start(): Promise<string> {
    if (this.address) return this.address;
    const server = createServer((request, response) => {
      void this.serve(request).then(
        (value) => { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ value: value ?? null })); },
        (error) => {
          const failure = error instanceof AppOperationError ? error : new AppOperationError("sql_error", (error as Error).message);
          const status = failure.code === "forbidden" ? 403 : 400;
          response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ code: failure.code, error: failure.message }));
        });
    });
    this.server = server;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const bound = server.address();
      this.address = `127.0.0.1:${typeof bound === "object" && bound ? bound.port : 0}`;
    } else {
      this.folder = mkdtempSync(join(tmpdir(), "omb-aoh-"));
      chmodSync(this.folder, 0o700);
      const socket = join(this.folder, "host.sock");
      await new Promise<void>((resolve) => server.listen(socket, resolve));
      this.address = `unix:${socket}`;
    }
    return this.address;
  }

  register(appId: string, secret: string) {
    this.apps.set(appId, { secretHash: digest(secret), invocations: this.apps.get(appId)?.invocations ?? new Map() });
  }

  unregister(appId: string) {
    this.apps.delete(appId);
  }

  open(appId: string, token: string, invocation: HostInvocation) {
    const entry = this.apps.get(appId);
    if (!entry) throw new Error(`App ${appId} is not registered with the host service.`);
    entry.invocations.set(token, invocation);
  }

  close(appId: string, token: string) {
    this.apps.get(appId)?.invocations.delete(token);
  }

  private appFor(secret: string): AppEntry | null {
    const hash = digest(secret);
    for (const entry of this.apps.values()) if (timingSafeEqual(entry.secretHash, hash)) return entry;
    return null;
  }

  private refuse(reason: string): never {
    this.refused.push(reason);
    throw new AppOperationError("forbidden", "The host service refused this request.");
  }

  private async serve(request: IncomingMessage): Promise<unknown> {
    const secrets = request.headersDistinct[APP_SECRET_HEADER] ?? [];
    const tokens = request.headersDistinct[INVOCATION_HEADER] ?? [];
    if (secrets.length !== 1) this.refuse(secrets.length ? "repeated secret" : "no secret");
    const entry = this.appFor(secrets[0]!);
    if (!entry) this.refuse("unknown secret");
    if (tokens.length !== 1) this.refuse("no invocation");
    const invocation = entry.invocations.get(tokens[0]!);
    if (!invocation) this.refuse("unknown invocation");
    if (request.method !== "POST") this.refuse("method");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).byteLength;
      if (size > HOST_BODY_BYTES) throw new AppOperationError("too_large", `A call to the host is at most ${HOST_BODY_BYTES} bytes.`);
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new AppOperationError("invalid_input", "The host takes JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppOperationError("invalid_input", "The host takes a JSON object.");
    return invocation.handle(new URL(request.url ?? "/", "http://host").pathname, body as Record<string, unknown>);
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.address = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.folder) rmSync(this.folder, { recursive: true, force: true });
    this.folder = null;
  }
}
