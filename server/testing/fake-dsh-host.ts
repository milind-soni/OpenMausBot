import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

import { dshClientRequestSchema, dshClientResponseSchema, dshJsonValueSchema, dshReceiptSchema, dshServerResponseSchema, dshStreamRequestSchema, dshUnaryValueSchema, type DshJsonValue } from "../drivers/deepseek-harness/protocol.ts";

export interface FakeDshRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: DshJsonValue;
}

type StreamKind = "mux" | "host";
const addressSchema = z.object({ port: z.number().int().positive().max(65_535) });

export class FakeDshHost {
  private readonly sockets = { mux: new Set<WebSocket>(), host: new Set<WebSocket>() };
  private readonly blockedStreams = new Set<StreamKind>();
  private readonly hungStreamHandshakes = new Set<StreamKind>();
  private readonly hungHandshakeSockets = { mux: new Set<Duplex>(), host: new Set<Duplex>() };
  private readonly hungHandshakeWaiters = { mux: new Array<() => void>(), host: new Array<() => void>() };
  private readonly streamWaiters = { mux: new Array<() => void>(), host: new Array<() => void>() };
  private readonly noStreamWaiters = { mux: new Array<() => void>(), host: new Array<() => void>() };
  private readonly rawResponseWaiters = new Array<() => void>();
  private readonly rawResponseCloseWaiters = new Array<() => void>();
  private readonly rawResponseSockets = new Set<Socket>();
  private readonly heldResponses = new Map<ServerResponse, FakeDshRequest>();
  private rawResponseCount = 0;
  private server: Server | null = null;
  private readonly webSocketServer = new WebSocketServer({ noServer: true });

  readonly requests: FakeDshRequest[] = [];
  /** The fake is deliberately schema-strict: tests must speak the host API, not a convenient approximation. */
  readonly invalidRequests: string[] = [];
  readonly invalidResponses: string[] = [];
  readonly streamHeaders = { mux: new Array<IncomingMessage["headers"]>(), host: new Array<IncomingMessage["headers"]>() };
  onRequest: (request: FakeDshRequest) => DshJsonValue = defaultFakeResponse;
  onRawRequest: ((request: FakeDshRequest, response: ServerResponse) => boolean) | undefined;
  onStreamOpen: ((kind: StreamKind, socket: WebSocket) => void) | undefined;

  get baseUrl(): string {
    const address = addressSchema.safeParse(this.server?.address());
    if (!address.success) throw new Error("fake DSH host is not listening");
    return `http://127.0.0.1:${address.data.port}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.webSocketServer.on("connection", (socket: WebSocket, _request: IncomingMessage, kind: StreamKind) => {
      this.streamHeaders[kind].push(_request.headers);
      this.sockets[kind].add(socket);
      this.onStreamOpen?.(kind, socket);
      socket.once("close", () => {
        this.sockets[kind].delete(socket);
        if (!this.sockets[kind].size) {
          for (const waiter of this.noStreamWaiters[kind].splice(0)) waiter();
        }
      });
      const waiter = this.streamWaiters[kind].shift();
      waiter?.();
    });
    this.server = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      let body: DshJsonValue = null;
      try {
        const parsed = dshJsonValueSchema.safeParse(text ? JSON.parse(text) : null);
        if (!parsed.success) throw new Error("invalid JSON value");
        body = parsed.data;
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }
      const fakeRequest = { path: request.url ?? "", headers: request.headers, body };
      this.requests.push(fakeRequest);
      const violation = strictRequestViolation(fakeRequest);
      if (violation) {
        this.invalidRequests.push(violation);
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid host api request" }));
        return;
      }
      const rawRequest = this.onRawRequest;
      const socket = response.socket;
      if (rawRequest) {
        if (!socket) throw new Error("raw response has no socket");
        if (rawRequest(fakeRequest, response)) {
          this.heldResponses.set(response, fakeRequest);
          this.rawResponseCount++;
          socket.once("close", () => {
            this.heldResponses.delete(response);
            this.rawResponseSockets.delete(socket);
            for (const waiter of this.rawResponseCloseWaiters.splice(0)) waiter();
          });
          this.rawResponseSockets.add(socket);
          for (const waiter of this.rawResponseWaiters.splice(0)) waiter();
          return;
        }
      }
      const responseBody = this.onRequest(fakeRequest);
      const responseViolation = strictResponseViolation(fakeRequest, responseBody);
      if (responseViolation) {
        this.invalidResponses.push(responseViolation);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid host api response fixture" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody));
    });
    this.server.on("upgrade", (request, socket, head) => {
      const kind = streamKindForPath(request.url ?? "");
      if (!kind) return socket.destroy();
      if (this.blockedStreams.has(kind)) return socket.destroy();
      if (this.hungStreamHandshakes.has(kind)) {
        this.hungHandshakeSockets[kind].add(socket);
        socket.once("close", () => this.hungHandshakeSockets[kind].delete(socket));
        for (const waiter of this.hungHandshakeWaiters[kind].splice(0)) waiter();
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
        this.webSocketServer.emit("connection", websocket, request, kind);
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    for (const kind of ["mux", "host"] as const) this.closeStreams(kind);
    for (const kind of ["mux", "host"] as const) {
      for (const socket of this.hungHandshakeSockets[kind]) socket.destroy();
    }
    for (const socket of this.rawResponseSockets) socket.destroy();
    await new Promise<void>((resolve) => this.webSocketServer.close(() => resolve()));
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  waitForStream(kind: StreamKind): Promise<void> {
    if (this.sockets[kind].size) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.streamWaiters[kind].indexOf(done);
        if (index !== -1) this.streamWaiters[kind].splice(index, 1);
        reject(new Error(`timed out waiting for ${kind} stream`));
      }, 2_000);
      timeout.unref?.();
      const done = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.streamWaiters[kind].push(done);
    });
  }

  waitForNoStreams(kind: StreamKind): Promise<void> {
    if (!this.sockets[kind].size) return Promise.resolve();
    return new Promise((resolve) => this.noStreamWaiters[kind].push(resolve));
  }

  waitForHungStreamHandshake(kind: StreamKind): Promise<void> {
    if (this.hungHandshakeSockets[kind].size) return Promise.resolve();
    return new Promise((resolve) => this.hungHandshakeWaiters[kind].push(resolve));
  }

  waitForRawResponse(): Promise<void> {
    if (this.rawResponseCount) return Promise.resolve();
    return new Promise((resolve) => this.rawResponseWaiters.push(resolve));
  }

  waitForRawResponseClose(): Promise<void> {
    if (!this.rawResponseSockets.size) return Promise.resolve();
    return new Promise((resolve) => this.rawResponseCloseWaiters.push(resolve));
  }

  /** Complete every deliberately held unary response using the current fixture handler. */
  releaseRawResponses(): void {
    for (const [response, request] of this.heldResponses) {
      this.heldResponses.delete(response);
      if (response.writableEnded) continue;
      const responseBody = this.onRequest(request);
      const violation = strictResponseViolation(request, responseBody);
      if (violation) {
        this.invalidResponses.push(violation);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid host api response fixture" }));
        continue;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody));
    }
  }

  /** Fail every deliberately held response at the transport boundary. */
  abortRawResponses(): void {
    for (const socket of this.rawResponseSockets) socket.destroy();
  }

  send(kind: StreamKind, frame: DshJsonValue): void {
    const violation = strictStreamViolation(kind, frame);
    if (violation) throw new Error(`invalid fake DSH ${kind} frame: ${violation}`);
    for (const socket of this.sockets[kind]) socket.send(JSON.stringify(frame));
  }

  sendRaw(kind: StreamKind, text: string): void {
    for (const socket of this.sockets[kind]) socket.send(text);
  }

  closeStreams(kind: StreamKind): void {
    for (const socket of this.sockets[kind]) socket.close();
  }

  streamCount(kind: StreamKind): number {
    return this.sockets[kind].size;
  }

  setStreamBlocked(kind: StreamKind, blocked: boolean): void {
    if (blocked) this.blockedStreams.add(kind);
    else this.blockedStreams.delete(kind);
  }

  setStreamHandshakeHung(kind: StreamKind, hung: boolean): void {
    if (hung) this.hungStreamHandshakes.add(kind);
    else this.hungStreamHandshakes.delete(kind);
  }
}

export function defaultFakeResponse({ body }: FakeDshRequest): DshJsonValue {
  if (dshClientResponseSchema.safeParse(body).success) return { accepted: true };
  const request = dshClientRequestSchema.parse(body);
  let value: DshJsonValue;
  if (request.method === "session.create") {
    const payload = sessionCreateSchema.parse(request.payload);
    value = { sessionId: payload.sessionId ?? "fake-session" };
  } else if (request.method === "session.selectModel") {
    const payload = selectModelSchema.parse(request.payload);
    const selected = selectModelSchema.pick({ provider: true, model: true, reasoningEffort: true }).strip().parse(payload);
    value = { selected };
  } else if (request.method === "session.prompt" || request.method === "session.cancel") {
    value = { accepted: true };
  } else if (request.method === "host.describe") {
    value = { version: "fake", cwd: "/fixture", attachedSessions: 0, home: "/fixture", canOpenPath: false };
  } else if (request.method === "llm.models") {
    value = { groups: [], failures: [] };
  } else if (request.method === "agentPreset.list") {
    value = { presets: [], authorable: false, hasDocument: false };
  } else {
    throw new Error(`unsupported fake response method ${request.method}`);
  }
  return { type: "server-response", rpcId: request.rpcId, result: { ok: true, value } };
}

const promptContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    data: z.string(),
    name: z.string().optional(),
  }),
]);
const sessionCreateSchema = z.object({
  cwd: z.string().optional(), workspaceId: z.string().min(1).optional(), sessionId: z.string().min(1).optional(), agentPreset: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.cwd !== undefined && value.workspaceId !== undefined) ctx.addIssue({ code: "custom", message: "cwd and workspaceId conflict" });
});
const selectModelSchema = z.object({
  sessionId: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional(),
}).strict();
const promptSchema = z.object({
  sessionId: z.string().min(1), mode: z.enum(["queue", "steer"]), content: z.array(promptContentSchema), clientTimeZone: z.string().optional(),
}).strict();
const cancelSchema = z.object({ sessionId: z.string().min(1) }).strict();
const approvalValueSchema = z.object({ sessionId: z.string().min(1), approvalId: z.string().min(1), outcome: z.enum(["allowed-once", "rejected"]) }).strict();
const questionValueSchema = z.object({
  sessionId: z.string().min(1),
  answer: z.object({ answers: z.array(z.object({ id: z.string(), selected: z.array(z.string()), custom: z.string().optional() }).strict()) }).strict(),
}).strict();

function strictRequestViolation(request: FakeDshRequest): string | null {
  if (request.path.endsWith("/respond")) {
    const parsed = dshClientResponseSchema.safeParse(request.body);
    if (!parsed.success) return "invalid client-response envelope";
    if (!parsed.data.result.ok) return parsed.data.result.error.code === "cancelled" ? null : "client-response error must be cancelled";
    const value = parsed.data.result.value;
    if (!approvalValueSchema.safeParse(value).success && !questionValueSchema.safeParse(value).success) return "invalid approval/question response value";
    return null;
  }
  const parsed = dshClientRequestSchema.safeParse(request.body);
  if (!parsed.success) return "invalid client-request envelope";
  if (!request.path.endsWith(`/${parsed.data.method}`)) return "request path and method differ";
  const schema = parsed.data.method === "session.create" ? sessionCreateSchema
    : parsed.data.method === "session.selectModel" ? selectModelSchema
      : parsed.data.method === "session.prompt" ? promptSchema
        : parsed.data.method === "session.cancel" ? cancelSchema
          : parsed.data.method === "host.describe" || parsed.data.method === "llm.models" || parsed.data.method === "agentPreset.list" ? z.object({}).strict()
            : null;
  if (!schema) return `unsupported ${parsed.data.method} method`;
  if (!schema.safeParse(parsed.data.payload).success) return `invalid ${parsed.data.method} payload`;
  return null;
}

function strictResponseViolation(request: FakeDshRequest, response: DshJsonValue): string | null {
  if (request.path.endsWith("/respond")) {
    return dshReceiptSchema.safeParse(response).success ? null : "invalid respond receipt";
  }
  const sent = dshClientRequestSchema.safeParse(request.body);
  if (!sent.success) return "response has no valid client request";
  const parsed = dshServerResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.rpcId !== sent.data.rpcId) return `invalid ${sent.data.method} response envelope`;
  if (!parsed.data.result.ok) return null;
  const schema = dshUnaryValueSchema(sent.data.method);
  return schema?.safeParse(parsed.data.result.value).success ? null : `invalid ${sent.data.method} success value`;
}

function strictStreamViolation(kind: StreamKind, frame: DshJsonValue): string | null {
  const parsed = dshStreamRequestSchema(kind).safeParse(frame);
  return parsed.success ? null : "invalid official stream envelope or payload";
}

function streamKindForPath(path: string): StreamKind | null {
  if (path.endsWith("/events.mux")) return "mux";
  if (path.endsWith("/events.host")) return "host";
  return null;
}
