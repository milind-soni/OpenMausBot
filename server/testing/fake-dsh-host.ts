import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

import { dshClientRequestSchema, dshJsonValueSchema, type DshJsonValue } from "../drivers/deepseek-harness/protocol.ts";

export interface FakeDshRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: DshJsonValue;
}

type StreamKind = "mux" | "host";
const addressSchema = z.object({ port: z.number().int().positive().max(65_535) });

export class FakeDshHost {
  private readonly sockets = { mux: new Set<WebSocket>(), host: new Set<WebSocket>() };
  private readonly streamWaiters = { mux: new Array<() => void>(), host: new Array<() => void>() };
  private readonly noStreamWaiters = { mux: new Array<() => void>(), host: new Array<() => void>() };
  private readonly rawResponseWaiters = new Array<() => void>();
  private readonly rawResponseCloseWaiters = new Array<() => void>();
  private readonly rawResponseSockets = new Set<Socket>();
  private rawResponseCount = 0;
  private server: Server | null = null;
  private readonly webSocketServer = new WebSocketServer({ noServer: true });

  readonly requests: FakeDshRequest[] = [];
  readonly streamHeaders = { mux: new Array<IncomingMessage["headers"]>(), host: new Array<IncomingMessage["headers"]>() };
  onRequest: (request: FakeDshRequest) => DshJsonValue = ({ body }) => {
    const request = dshClientRequestSchema.safeParse(body);
    const rpcId = request.success ? request.data.rpcId : "missing";
    return { type: "server-response", rpcId, result: { ok: true, value: {} } };
  };
  onRawRequest: ((request: FakeDshRequest, response: ServerResponse) => boolean) | undefined;

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
      const rawRequest = this.onRawRequest;
      const socket = response.socket;
      if (rawRequest) {
        if (!socket) throw new Error("raw response has no socket");
        if (rawRequest(fakeRequest, response)) {
          this.rawResponseCount++;
          socket.once("close", () => {
            this.rawResponseSockets.delete(socket);
            for (const waiter of this.rawResponseCloseWaiters.splice(0)) waiter();
          });
          this.rawResponseSockets.add(socket);
          for (const waiter of this.rawResponseWaiters.splice(0)) waiter();
          return;
        }
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(this.onRequest(fakeRequest)));
    });
    this.server.on("upgrade", (request, socket, head) => {
      const kind = streamKindForPath(request.url ?? "");
      if (!kind) return socket.destroy();
      this.webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
        this.webSocketServer.emit("connection", websocket, request, kind);
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    for (const kind of ["mux", "host"] as const) this.closeStreams(kind);
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

  waitForRawResponse(): Promise<void> {
    if (this.rawResponseCount) return Promise.resolve();
    return new Promise((resolve) => this.rawResponseWaiters.push(resolve));
  }

  waitForRawResponseClose(): Promise<void> {
    if (!this.rawResponseSockets.size) return Promise.resolve();
    return new Promise((resolve) => this.rawResponseCloseWaiters.push(resolve));
  }

  send(kind: StreamKind, frame: DshJsonValue): void {
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
}

function streamKindForPath(path: string): StreamKind | null {
  if (path.endsWith("/events.mux")) return "mux";
  if (path.endsWith("/events.host")) return "host";
  return null;
}
