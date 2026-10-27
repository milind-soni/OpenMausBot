// One WebSocket between a lent computer and My Cloud carries many TCP streams. My Cloud opens one for each connection
// its browsers make, the computer connects it, and each side sends a stream's bytes only while the other has room for
// them, so neither end buffers more than a window per stream.
//
// Text frames are JSON: open {id, host, port} or {id, chrome: true} (My Cloud), opened {id} / refused {id, reason} / failed {id, reason} (the
// computer), credit {id, bytes}, end {id}, close {id}, ping / pong, and hello {seenAs} (My Cloud, once). A binary frame
// is a stream's bytes: its id as 4 bytes, big-endian, then at most MAX_CHUNK bytes.

export const linkPath = (computerId) => `/api/shared-computers/${computerId}/link`;
/** Close codes My Cloud sends: going to sleep (the computer waits for it to wake), and lending there ended. */
export const LINK_ASLEEP = 4001;
export const LINK_ENDED = 4002;
export const STREAM_WINDOW = 256 * 1024;
export const MAX_CHUNK = 64 * 1024;
export const MAX_STREAMS = 128;
export const OPEN_MS = 20_000;
const MAX_ID = 0xffff_ffff;

const header = (id) => { const bytes = Buffer.allocUnsafe(4); bytes.writeUInt32BE(id); return bytes; };
const validId = (id) => Number.isInteger(id) && id > 0 && id <= MAX_ID;

/**
 * `send(frame)` writes a string or Buffer to the WebSocket. `accept(target)`, on the computer's side only, connects a
 * stream My Cloud opened and answers `{ socket }`, `{ refused }` or `{ failed }`. `traffic()` is called whenever bytes move.
 */
export function createLinkMux({ send, accept = null, window = STREAM_WINDOW, maxStreams = MAX_STREAMS, openMs = OPEN_MS, traffic = () => {} }) {
  const streams = new Map();
  let nextId = 1;
  let closed = false;
  const control = (message) => { if (!closed) send(JSON.stringify(message)); };

  const stream = (id) => ({ id, socket: null, pending: [], room: window, unread: 0, consumed: 0, credited: 0, inbox: [], ended: false, endSent: false, peerEnded: false, settle: null, timer: null });

  /** Sends what the peer has room for; a socket whose bytes wait for room is paused. */
  const flush = (entry) => {
    while (entry.pending.length && entry.room > 0 && !closed) {
      const chunk = entry.pending[0];
      const size = Math.min(chunk.length, entry.room, MAX_CHUNK);
      if (size === chunk.length) entry.pending.shift(); else entry.pending[0] = chunk.subarray(size);
      entry.room -= size;
      send(Buffer.concat([header(entry.id), chunk.subarray(0, size)]));
      traffic();
    }
    if (entry.pending.length) { entry.socket?.pause(); return; }
    entry.socket?.resume();
    if (entry.ended && !entry.endSent) { entry.endSent = true; control({ t: "end", id: entry.id }); }
  };

  const forget = (entry, tellPeer) => {
    if (streams.get(entry.id) !== entry) return;
    streams.delete(entry.id);
    clearTimeout(entry.timer);
    if (tellPeer) control({ t: "close", id: entry.id });
    entry.settle?.({ failed: "refused" });
    entry.settle = null;
    entry.socket?.destroy();
  };

  /** The peer's bytes were written here: room for that much more is sent back once a quarter window has drained. */
  const drained = (entry, size) => {
    entry.consumed += size;
    if (entry.consumed - entry.credited >= window / 4 && streams.get(entry.id) === entry) {
      control({ t: "credit", id: entry.id, bytes: entry.consumed - entry.credited });
      entry.credited = entry.consumed;
    }
  };

  const write = (entry, bytes) => {
    entry.socket.write(bytes, (error) => { if (!error) drained(entry, bytes.length); });
  };

  const attach = (entry, socket, early = []) => {
    entry.socket = socket;
    socket.on("data", (chunk) => { entry.pending.push(chunk); flush(entry); });
    socket.on("end", () => { entry.ended = true; flush(entry); });
    socket.on("close", () => forget(entry, true));
    socket.on("error", () => socket.destroy());
    for (const bytes of entry.inbox.splice(0)) write(entry, bytes);
    if (entry.peerEnded) socket.end();
    for (const chunk of early) if (chunk.length) entry.pending.push(chunk);
    flush(entry);
  };

  const onControl = (message) => {
    const entry = validId(message?.id) ? streams.get(message.id) : undefined;
    switch (message?.t) {
      case "open": {
        if (!accept || !validId(message.id) || streams.has(message.id)) return;
        if (streams.size >= maxStreams) return control({ t: "failed", id: message.id, reason: "busy" });
        const opening = stream(message.id);
        streams.set(opening.id, opening);
        void Promise.resolve().then(() => accept(message.chrome === true ? { chrome: true } : { host: message.host, port: message.port })).catch(() => ({ failed: "unreachable" })).then((result) => {
          if (streams.get(opening.id) !== opening || closed) { result?.socket?.destroy(); return; }
          if (result?.socket) { control({ t: "opened", id: opening.id }); attach(opening, result.socket); return; }
          streams.delete(opening.id);
          control(result?.refused ? { t: "refused", id: opening.id, reason: result.refused } : { t: "failed", id: opening.id, reason: result?.failed ?? "unreachable" });
        });
        return;
      }
      case "opened":
        if (!entry?.settle) return;
        clearTimeout(entry.timer);
        entry.settle({ join: (socket, early) => attach(entry, socket, early), cancel: () => forget(entry, true) });
        entry.settle = null;
        return;
      case "refused":
      case "failed":
        if (!entry?.settle) return;
        clearTimeout(entry.timer);
        streams.delete(entry.id);
        entry.settle(message.t === "refused" ? { refused: String(message.reason) } : { failed: String(message.reason) });
        entry.settle = null;
        return;
      case "credit":
        if (!entry || !Number.isInteger(message.bytes) || message.bytes <= 0) return;
        entry.room += message.bytes;
        // More room than a window means the peer is not counting what it was sent: the stream is not to be trusted.
        if (entry.room > window) return forget(entry, true);
        return flush(entry);
      case "end":
        if (!entry) return;
        entry.peerEnded = true;
        entry.socket?.end();
        return;
      case "close":
        if (entry) forget(entry, false);
        return;
    }
  };

  const onData = (frame) => {
    if (frame.length < 4) return;
    const entry = streams.get(frame.readUInt32BE(0));
    if (!entry || entry.settle) return;
    const bytes = frame.subarray(4);
    entry.unread += bytes.length;
    // Bytes beyond the room this side gave: the peer ignores flow control, so the stream ends.
    if (entry.unread - entry.credited > window) return forget(entry, true);
    traffic();
    if (entry.socket) write(entry, Buffer.from(bytes));
    else entry.inbox.push(Buffer.from(bytes));
  };

  return {
    /** A WebSocket message: a JSON control frame, or a stream's bytes. */
    receive(data) {
      if (closed) return;
      if (typeof data === "string") {
        let message;
        try { message = JSON.parse(data); } catch { return; }
        onControl(message);
        return;
      }
      onData(Buffer.isBuffer(data) ? data : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data));
    },
    /** My Cloud's side: a stream to `host:port`, or to the computer's Chrome, through the computer. `{ gone }` when the link ended before it answered. */
    open(target) {
      if (closed) return Promise.resolve({ gone: true });
      if (streams.size >= maxStreams) return Promise.resolve({ failed: "busy" });
      while (streams.has(nextId)) nextId = nextId >= MAX_ID ? 1 : nextId + 1;
      const entry = stream(nextId);
      nextId = nextId >= MAX_ID ? 1 : nextId + 1;
      streams.set(entry.id, entry);
      return new Promise((settle) => {
        entry.settle = settle;
        // No answer this long: the link is not carrying anything, so the connection goes another way.
        entry.timer = setTimeout(() => { if (entry.settle) { entry.settle({ gone: true }); entry.settle = null; forget(entry, true); } }, openMs);
        entry.timer.unref?.();
        control(target.chrome === true ? { t: "open", id: entry.id, chrome: true } : { t: "open", id: entry.id, host: target.host, port: target.port });
      });
    },
    get size() { return streams.size; },
    /** The link ended: every stream ends with it, and one still opening goes another way. */
    close() {
      if (closed) return;
      closed = true;
      for (const entry of streams.values()) {
        streams.delete(entry.id);
        clearTimeout(entry.timer);
        entry.settle?.({ gone: true });
        entry.settle = null;
        entry.socket?.destroy();
      }
    },
  };
}
