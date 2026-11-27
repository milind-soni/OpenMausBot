import type { LiveEventSourceLike } from "./relay-server";

export function websocketEvents(url: string): LiveEventSourceLike {
  const endpoint = new URL(url, window.location.href);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(endpoint);
  const adapter: LiveEventSourceLike = {
    onopen: null,
    onerror: null,
    onmessage: null,
    close: () => {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    },
  };
  socket.onerror = () => adapter.onerror?.();
  socket.onclose = () => adapter.onerror?.();
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    let envelope: unknown;
    try { envelope = JSON.parse(event.data); } catch { return; }
    if (!envelope || typeof envelope !== "object" || !("frame" in envelope)) return;
    const frame = envelope.frame;
    if (!frame || typeof frame !== "object" || !("kind" in frame) || typeof frame.kind !== "string") return;
    const id = "id" in envelope ? envelope.id : undefined;
    if (id !== undefined && typeof id !== "string") return;
    adapter.onmessage?.({ data: JSON.stringify(frame), lastEventId: id });
  };
  return adapter;
}
