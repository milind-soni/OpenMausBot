// A stand-in for the MausBot Cloud Admin's side of the connector protocol (connector/src/protocol.ts): one-time codes,
// enrolment, the agent WebSocket with its Bearer token, heartbeats, jobs and their replies, and export uploads. The
// unit tests drive it in process; the e2e runs it as a program and drives it over its /control routes on loopback:
//   node connector/test/fake-admin.ts <port> <code>
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { WebSocketServer, type WebSocket } from "ws";

import {
  CLOSE_REPLACED, CLOSE_UNAUTHORIZED, CONNECT_PATH, ENROLL_PATH, EXPORT_PATH,
  type EnrollRequest, type EnrollResponse, type Heartbeat, type JobReply, type JobType, type JobArgs,
} from "../src/protocol.ts";

interface EnrolledServer {
  serverId: string;
  cloudId: string;
  token: string;
  enroll: EnrollRequest;
}

export class FakeAdmin {
  readonly codes = new Set<string>();
  readonly servers = new Map<string, EnrolledServer>();
  readonly heartbeats: Heartbeat["heartbeat"][] = [];
  readonly replies: JobReply[] = [];
  /** Every reply message per job id, repeats included. */
  readonly replyCounts = new Map<string, number>();
  readonly exports = new Map<string, Buffer>();
  readonly connections: { token: string; at: number }[] = [];
  /** Tokens the Admin forgot: their next connection is closed with 4401. */
  readonly revoked = new Set<string>();
  private socket: WebSocket | null = null;
  private readonly waiting = new Map<string, (reply: JobReply) => void>();
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private nextJob = 1;

  constructor() {
    this.http = createServer((req, res) => {
      this.route(req, res).catch((error) => {
        res.writeHead(500).end(String(error));
      });
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.http.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://admin").pathname !== CONNECT_PATH) {
        socket.destroy();
        return;
      }
      const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const known = [...this.servers.values()].some((server) => server.token === token);
        if (!known || this.revoked.has(token)) {
          ws.close(CLOSE_UNAUTHORIZED, "unknown token");
          return;
        }
        this.connections.push({ token, at: Date.now() });
        this.socket?.close(CLOSE_REPLACED, "a newer connection took over");
        this.socket = ws;
        ws.on("message", (data) => this.received(String(data)));
        ws.on("close", () => {
          if (this.socket === ws) this.socket = null;
        });
      });
    });
  }

  async listen(port = 0): Promise<string> {
    await new Promise<void>((resolve) => this.http.listen(port, "127.0.0.1", resolve));
    return this.origin;
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  mintCode(code = `MB-${randomBytes(4).toString("hex").toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`): string {
    this.codes.add(code);
    return code;
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /** Drops the connection as a network failure would. */
  drop(): void {
    this.socket?.terminate();
    this.socket = null;
  }

  send(message: unknown): void {
    if (!this.socket) throw new Error("no connector is connected");
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  /** Sends a job and resolves with the next reply to its id. */
  job<T extends JobType>(type: T, args: JobArgs[T] | Record<string, unknown>, id = `job-${this.nextJob++}`, timeoutMs = 30 * 60_000): Promise<JobReply> {
    const reply = new Promise<JobReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`no reply to ${type} ${id}`));
      }, timeoutMs);
      this.waiting.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    this.send({ id, type, args });
    return reply;
  }

  /** The reply to a job id, whenever it arrives (a job answered after a reconnect, or by a new connector). */
  replyTo(id: string, timeoutMs = 30 * 60_000): Promise<JobReply> {
    const answered = this.replies.find((reply) => reply.id === id);
    if (answered) return Promise.resolve(answered);
    return new Promise<JobReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${id}`)), timeoutMs);
      this.waiting.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  private received(text: string): void {
    const message = JSON.parse(text) as Heartbeat | JobReply;
    if ("heartbeat" in message) {
      this.heartbeats.push(message.heartbeat);
      return;
    }
    this.replyCounts.set(message.id, (this.replyCounts.get(message.id) ?? 0) + 1);
    this.send({ ack: message.id });
    if (this.replies.some((reply) => reply.id === message.id) && !this.waiting.has(message.id)) return;
    this.replies.push(message);
    const waiter = this.waiting.get(message.id);
    if (waiter) {
      this.waiting.delete(message.id);
      waiter(message);
    }
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://admin");
    if (req.method === "POST" && url.pathname === ENROLL_PATH) {
      let request: EnrollRequest;
      try { request = JSON.parse((await this.body(req)).toString("utf8")) as EnrollRequest; } catch { return this.json(res, 400, { error: "invalid_body" }); }
      if (!this.codes.delete(request.code)) return this.json(res, 401, { error: "invalid_code" });
      const answer: EnrollResponse = { serverId: `srv_${randomBytes(6).toString("hex")}`, cloudId: `cloud_${randomBytes(6).toString("hex")}`, agentToken: `ombs_${randomBytes(32).toString("base64url")}` };
      this.servers.set(answer.serverId, { ...answer, token: answer.agentToken, enroll: request });
      return this.json(res, 200, answer);
    }
    if (req.method === "PUT" && url.pathname.startsWith(`${EXPORT_PATH}/`)) {
      const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
      if (![...this.servers.values()].some((server) => server.token === token)) return this.json(res, 401, { error: "unauthorized" });
      this.exports.set(url.pathname.slice(EXPORT_PATH.length + 1), await this.body(req));
      return this.json(res, 200, { ok: true });
    }
    // The e2e's handle on this Admin; never part of the protocol.
    if (url.pathname === "/control/state" && req.method === "GET") {
      return this.json(res, 200, { connected: this.connected, servers: [...this.servers.values()].map(({ serverId, cloudId, enroll }) => ({ serverId, cloudId, host: enroll.host, connector: enroll.connector })),
        heartbeats: this.heartbeats.length, lastHeartbeat: this.heartbeats.at(-1) ?? null, connections: this.connections.length });
    }
    if (url.pathname === "/control/job" && req.method === "POST") {
      const { type, args, id } = JSON.parse((await this.body(req)).toString("utf8")) as { type: JobType; args: Record<string, unknown>; id?: string };
      try {
        return this.json(res, 200, await this.job(type, args, id));
      } catch (error) {
        return this.json(res, 504, { error: String(error) });
      }
    }
    if (url.pathname === "/control/reply" && req.method === "GET") {
      try {
        return this.json(res, 200, await this.replyTo(url.searchParams.get("id") ?? "", Number(url.searchParams.get("timeoutMs") ?? 600_000)));
      } catch (error) {
        return this.json(res, 504, { error: String(error) });
      }
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [port, code] = process.argv.slice(2);
  const admin = new FakeAdmin();
  if (code) admin.mintCode(code);
  const origin = await admin.listen(Number(port ?? 0));
  console.log(`fake admin on ${origin}`);
}
