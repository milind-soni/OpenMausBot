import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { LiveCallController } from "../live-call-controller.ts";
import { livePlaybackCreditSchema, liveClientFailureSchema } from "../live-media-protocol.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { Upgrades } from "./upgrades.ts";

const bind = z.object({ type: z.literal("bind"), callId: z.string().min(1).max(120), playbackFlow: z.literal("credit-v1").optional() }).strict();
const hangup = z.object({ type: z.literal("hangup") }).strict();
const PATH = "/api/live/media";

export function createLiveMediaRoutes(deps: {
  upgrades: Upgrades;
  calls: Pick<LiveCallController, "bindMedia" | "inputMedia" | "playbackCredit" | "clientFailure" | "mediaDisconnected" | "end">;
  log?: (line: string) => void;
}): RouteHandler & { close(): void } {
  const server = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  const clients = new Set<WebSocket>();
  deps.upgrades.route((path) => path === PATH);
  const route: RouteHandler = async ({ req, res, path, method, url, auth, json }) => {
    if (path !== PATH) return PASS;
    if (method !== "GET" || url.search) return json(res, 400, { error: "The audio connection uses a fixed path without query parameters." });
    const upgrade = deps.upgrades.pending(req);
    if (!upgrade) return json(res, 426, { error: "Open the audio WebSocket connection." });
    upgrade.release();
    server.handleUpgrade(req, upgrade.socket, upgrade.head, (socket) => {
      clients.add(socket);
      const openedAt = Date.now();
      let callId: string | null = null;
      let playbackFlow: "credit-v1" | undefined;
      const controls: number[] = [];
      const timer = setTimeout(() => socket.close(1008, "bind required"), 5_000);
      timer.unref();
      // Idle calls carry no audio frames; without keepalive a proxy or NAT can drop the socket mid-call.
      let alive = true;
      socket.on("pong", () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (socket.readyState !== 1) return;
        if (!alive) { socket.terminate(); return; }
        alive = false;
        try { socket.ping(); } catch {}
      }, 25_000);
      heartbeat.unref();
      socket.on("error", () => socket.close(1008, "audio connection failed"));
      socket.once("close", (code) => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        clients.delete(socket);
        deps.log?.(`[live] media socket closed code=${code} bound=${callId ? "yes" : "no"} ms=${Date.now() - openedAt}`);
        if (callId) deps.calls.mediaDisconnected(callId);
      });
      socket.on("message", (raw, binary) => {
        if (socket.readyState !== 1) return;
        const bytes = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
        if (binary) {
          if (!callId || !bytes.length || bytes.length % 2 || !deps.calls.inputMedia(callId, bytes)) socket.close(1008, "invalid PCM input");
          return;
        }
        const now = Date.now();
        while (controls.length && controls[0]! <= now - 1_000) controls.shift();
        if (controls.length >= 120) { socket.close(1008, "control rate limit"); return; }
        controls.push(now);
        let event: unknown;
        try {
          if (bytes.byteLength > 512) throw new Error("control frame limit");
          event = JSON.parse(bytes.toString());
        } catch { socket.close(1008, "invalid control"); return; }
        if (!callId) {
          const parsed = bind.safeParse(event);
          if (!parsed.success) { socket.close(1008, "call binding refused"); return; }
          const accepted = parsed.data.playbackFlow ? deps.calls.bindMedia(parsed.data.callId, auth, socket, parsed.data.playbackFlow) : deps.calls.bindMedia(parsed.data.callId, auth, socket);
          if (!accepted) { socket.close(1008, "call binding refused"); return; }
          callId = parsed.data.callId;
          playbackFlow = parsed.data.playbackFlow;
          clearTimeout(timer);
          return;
        }
        const credit = playbackFlow && livePlaybackCreditSchema.safeParse(event);
        if (credit && credit.success) {
          if (!deps.calls.playbackCredit(callId, credit.data)) socket.close(1008, "playback credit refused");
          return;
        }
        const failure = playbackFlow && liveClientFailureSchema.safeParse(event);
        if (failure && failure.success) {
          if (!deps.calls.clientFailure(callId, failure.data)) socket.close(1008, "client failure refused");
          return;
        }
        if (!hangup.safeParse(event).success) { socket.close(1008, "only PCM and hangup are allowed"); return; }
        void deps.calls.end(callId).catch(() => socket.close(1011, "hangup failed"));
      });
    });
  };
  return Object.assign(route, { close() {
    for (const socket of clients) socket.close(1001, "server shutdown");
    server.close();
  } });
}
