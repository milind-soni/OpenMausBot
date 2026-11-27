import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { isSameOrigin, type RequestAuth } from "../request-auth.ts";
import { deliverSseFrame, openSseHeartbeat, SSE_MAX_BUFFERED_BYTES } from "../sse-fanout.ts";
import type { Upgrades } from "./upgrades.ts";

export interface EventWriter {
  send(kind: string, json: string, id?: string): boolean;
  close(): void;
}

export function createEventFeed(upgrades: Upgrades, everyMs: number, sessionLive: (id: string) => boolean) {
  upgrades.route(path => path === "/api/events");
  const sockets = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: 128 });
  return (req: IncomingMessage, res: ServerResponse, auth: RequestAuth, subscribe: (writer: EventWriter) => void, onClose: () => void): void => {
    const live = () => auth.kind === "loopback" || sessionLive(auth.session.id);
    const pending = upgrades.pending(req);
    if (!pending) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      const close = openSseHeartbeat(res, { everyMs, live, onClose });
      const sink = { res, close, backpressured: false };
      req.socket.setTimeout(0);
      res.once("close", close);
      subscribe({ close, send(kind, json, id) {
        if (deliverSseFrame(sink, kind, `${id === undefined ? "" : `id: ${id}\n`}data: ${json}\n\n`) !== "disconnected") return true;
        close();
        return false;
      } });
      return;
    }
    if (auth.kind !== "session" || auth.via !== "cookie" || !req.headers.origin || !isSameOrigin(req) || !live()) {
      res.writeHead(403).end();
      return;
    }
    if (pending.socket.destroyed) return;
    pending.release();
    sockets.handleUpgrade(req, pending.socket, pending.head, ws => {
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(timer);
        onClose();
        ws.terminate();
      };
      const send = (kind: string, json: string, id?: string): boolean => {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > SSE_MAX_BUFFERED_BYTES || auth.session.expiresAt <= Date.now()) {
          close();
          return false;
        }
        if (kind !== "screen" || !ws.bufferedAmount) ws.send(id === undefined ? `{"frame":${json}}` : `{"id":${JSON.stringify(id)},"frame":${json}}`);
        return true;
      };
      const timer = setInterval(() => live() ? send("ping", '{"kind":"ping"}') : close(), everyMs);
      timer.unref();
      ws.once("error", close);
      ws.once("close", close);
      ws.once("message", close);
      subscribe({ send, close });
    });
  };
}
