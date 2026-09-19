// The /api/events SSE endpoint and the fan-out state it serves. Extracted
// from index.ts (see ../workspace-backup-http.ts for the pattern): the
// client set, replay buffer, heartbeat, and cursor math are private to the
// factory, and index keeps only the wiring that touches its own singletons
// — session revocation, queue-change notification — plus the broadcast()
// handle the rest of the server pushes frames through.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { deliverSseFrame } from "../sse-fanout.ts";
import type { RequestAuth } from "../request-auth.ts";

/** One connected client, and what it asked to be sent. */
interface SseClient {
  res: ServerResponse;
  admin: boolean;
  /** Live screen frames carry a base64 desktop capture every few seconds
   * while a bot works. A client that isn't showing the computer panel —
   * a phone on cellular, most of all — should not pay for them. */
  screens: boolean;
  /** The paired session behind this stream, when there is one: revoking or
   * expiring it must end the stream, not just future requests. */
  sessionId?: string;
  /** Set once this client's socket has signalled it can't keep up (write()
   * returned false); cleared implicitly once it's disconnected. See
   * ../sse-fanout.ts for what this does to fan-out. */
  backpressured: boolean;
}

export interface EventsRoutesOptions {
  /** Close another owner surface (the live browser) before the session's
   *  SSE clients are dropped. */
  closeForOwner(sessionId: string): void;
  /** Re-check email sessions for membership changes made out-of-band
   *  (fleet/CLI config writes) before further workspace data is delivered. */
  revalidateEmailSessions(): void;
  /** Whether a paired session is still live; an expired session's stream
   *  ends at the next heartbeat. */
  isLive(sessionId: string): boolean;
  /** The client (non-admin) projection of a config broadcast payload. */
  configForAccess(status: unknown, admin: boolean): Record<string, unknown>;
}

export interface EventsRoutes {
  /** Frame every connected client: number the frame, keep it for replay,
   *  and deliver it with the fan-out rules (screen dropping, bound). */
  broadcast(payload: Record<string, unknown>): void;
  /** End every stream a session owns — revocation or expiry. */
  closeSessionStreams(sessionId: string): void;
  /** The /api/events branch of index.ts's dispatch chain. False means the
   *  request is not ours and the chain must keep going. */
  handle(req: IncomingMessage, res: ServerResponse, path: string, method: string, url: URL, auth: RequestAuth): boolean;
}

export function createEventsRoutes(options: EventsRoutesOptions): EventsRoutes {
  const sseClients = new Set<SseClient>();
  // One idempotent cleanup per client: every termination path (response
  // close, session revocation, fan-out disconnect) must clear the heartbeat
  // timer and drop the registration exactly once.
  const clientCleanups = new Map<SseClient, () => void>();
  const stopClient = (client: SseClient) => clientCleanups.get(client)?.();
  function closeSessionStreams(sessionId: string): void {
    options.closeForOwner(sessionId);
    for (const client of sseClients) {
      if (client.sessionId !== sessionId) continue;
      stopClient(client);
      try {
        client.res.end();
      } catch {
        /* already gone */
      }
    }
  }

  /** Every frame is numbered, and the last few hundred are kept, so a client
   * whose connection dropped can ask for what it missed instead of
   * re-downloading every transcript. The desktop reconnects in milliseconds
   * and barely needs this; a phone reconnects every time it unlocks.
   *
   * The stream id makes the cursor safe across restarts: sequence numbers
   * begin again at 1 on boot, so a cursor from a previous run must be
   * rejected rather than used to replay a different run's frames. It rides
   * inside the SSE `id:` field, which means a browser EventSource resumes
   * correctly through its own Last-Event-ID with no client code at all. */
  const STREAM_ID = randomUUID().slice(0, 8);
  const REPLAY_MAX = 500;
  const configuredSseHeartbeatMs = Number(process.env.OMB_SSE_HEARTBEAT_MS);
  const SSE_HEARTBEAT_MS =
    Number.isFinite(configuredSseHeartbeatMs) && configuredSseHeartbeatMs > 0
      ? configuredSseHeartbeatMs
      : 15_000;
  let lastSeq = 0;
  const replayBuffer: Array<{ seq: number; kind: string; frame: string | null; clientFrame: string | null }> = [];

  /** Screen frames are the only kind a client can decline. */
  const wants = (client: SseClient, kind: string) => kind !== "screen" || client.screens;

  /** `<streamId>:<seq>` — opaque to clients, and the only thing they need to
   * remember to resume. Returns null when it belongs to another run. */
  function cursorSeq(raw: string | string[] | undefined): number | null {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) return null;
    const [stream, seq] = value.split(":");
    if (stream !== STREAM_ID) return null;
    const parsed = Number(seq);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  function broadcast(payload: Record<string, unknown>) {
    // Membership may also change through fleet/CLI config writes. Close stale
    // email streams before any further workspace data is delivered.
    options.revalidateEmailSessions();
    const seq = ++lastSeq;
    const kind = String(payload.kind ?? "");
    const frame = `id: ${STREAM_ID}:${seq}\ndata: ${JSON.stringify({ ...payload, seq })}\n\n`;
    // Store both projections as immutable frames: live and reconnecting clients
    // must receive the same filtered config without changing the admin event.
    const clientFrame = kind === "config"
      ? `id: ${STREAM_ID}:${seq}\ndata: ${JSON.stringify({ ...options.configForAccess(payload, false), kind, seq })}\n\n`
      : frame;
    // Live desktop captures can each be hundreds of kilobytes and become stale
    // as soon as the next one arrives. Keep their sequence slots so resume-gap
    // detection stays honest, but never retain their base64 payloads.
    replayBuffer.push({ seq, kind, frame: kind === "screen" ? null : frame, clientFrame: kind === "screen" ? null : clientFrame });
    if (replayBuffer.length > REPLAY_MAX) replayBuffer.shift();
    for (const client of Array.from(sseClients)) {
      if (!wants(client, kind)) continue;
      // Screen frames are replaceable and durable events are not: see
      // ../sse-fanout.ts for the backpressure/bound decision this makes.
      if (deliverSseFrame(client, kind, client.admin ? frame : clientFrame) === "disconnected") {
        stopClient(client);
      }
    }
  }

  const handle = (req: IncomingMessage, res: ServerResponse, path: string, method: string, url: URL, auth: RequestAuth): boolean => {
    if (method === "GET" && path === "/api/events") {
      const client: SseClient = {
        res,
        admin: auth.scopes.includes("admin"),
        screens: url.searchParams.get("screens") !== "off",
        backpressured: false,
      };
      if (auth.kind === "session") client.sessionId = auth.session.id;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        // Honoured by nginx-compatible reverse proxies; harmless elsewhere.
        // Remote clients need each frame now, not when a proxy buffer fills.
        "x-accel-buffering": "no",
      });

      // Resume, if the client offered a cursor we can honour. `?since=` is
      // for clients that read the stream by hand; Last-Event-ID is what a
      // browser EventSource sends by itself.
      // Once EventSource has received a numbered frame, its automatic
      // reconnect carries a newer Last-Event-ID even though the original
      // URL may still contain an older manual `since` cursor. Prefer the
      // valid browser cursor or the stale query would replay forever.
      const since =
        cursorSeq(req.headers["last-event-id"]) ??
        cursorSeq(url.searchParams.get("since") ?? undefined);
      // The buffer only reaches so far back. If the client's cursor fell off
      // the end, saying so is the only honest answer — a partial replay
      // would leave a permanent hole in its state.
      const resumed =
        since !== null &&
        since <= lastSeq &&
        (replayBuffer.length === 0 ? since === lastSeq : replayBuffer[0].seq <= since + 1);
      res.write(
        `data: ${JSON.stringify({
          kind: "hello",
          cursor: `${STREAM_ID}:${lastSeq}`,
          // false means "I could not give you what you missed — hydrate".
          // A client that offered no cursor gets false too, which is exactly
          // what a cold start should do.
          resumed,
        })}\n\n`,
      );
      if (resumed) {
        for (const buffered of replayBuffer) {
          const frame = client.admin ? buffered.frame : buffered.clientFrame;
          if (buffered.seq > since && frame && wants(client, buffered.kind)) {
            if (deliverSseFrame(client, buffered.kind, frame) === "disconnected") {
              return true;
            }
          }
        }
      }

      sseClients.add(client);
      // Keep this long-lived response out of socket idle-timeout handling
      // without weakening timeouts for every other API request.
      req.socket.setTimeout(0);
      // A comment keeps intermediaries from idling the connection, while a
      // data frame is visible to EventSource clients and resets their own
      // liveness watchdog. Heartbeats carry no id and never advance replay.
      // They ride the same buffered-byte bound as every other frame, so a
      // client that stopped reading is cut loose rather than queued forever.
      const keepalive = setInterval(() => {
        // an expired session's stream ends at the next heartbeat
        if (client.sessionId && !options.isLive(client.sessionId)) {
          clearInterval(keepalive);
          sseClients.delete(client);
          res.end();
          return;
        }
        const heartbeat = `: keepalive\n\ndata: ${JSON.stringify({ kind: "ping" })}\n\n`;
        if (deliverSseFrame(client, "ping", heartbeat) === "disconnected") {
          stopClient(client);
        }
      }, SSE_HEARTBEAT_MS);
      const cleanup = () => {
        clearInterval(keepalive);
        sseClients.delete(client);
        clientCleanups.delete(client);
      };
      clientCleanups.set(client, cleanup);
      // The response, not the request, owns this stream's lifetime: req
      // "close" fires when the request completes (immediately for a bodyless
      // GET), so only res "close" reliably means the client went away.
      res.once("close", cleanup);
      return true;
    }
    return false;
  };

  return { broadcast, closeSessionStreams, handle };
}
