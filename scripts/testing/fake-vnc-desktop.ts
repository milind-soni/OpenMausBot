// An offline RFB 3.8 desktop with a real-sized picture and VNC
// authentication, for driving a client the way a person would: every pointer
// and key event is recorded, and each click paints a marker where it landed
// so the client's next update shows it. No host display, container daemon or
// network outside loopback is used.
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";

export interface FakeVncDesktopOptions {
  width?: number;
  height?: number;
  /** Paints the initial desktop as RGB triples, row-major. */
  paint?: (x: number, y: number) => [number, number, number];
}

export interface PointerEvent { x: number; y: number; buttons: number }

export async function fakeVncDesktop(options: FakeVncDesktopOptions = {}) {
  const width = options.width ?? 1280;
  const height = options.height ?? 800;
  const paint = options.paint ?? (() => [0x1a, 0x24, 0x36]);
  // BGRX, little-endian 32-bit: what a client asking for true colour with
  // red at 16, green at 8 and blue at 0 expects.
  const framebuffer = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const at = (y * width + x) * 4;
      framebuffer[at] = b; framebuffer[at + 1] = g; framebuffer[at + 2] = r;
    }
  }
  const server = createServer((_req, res) => res.writeHead(404).end());
  const sockets = new WebSocketServer({ server, path: "/websockify" });
  const pointer: PointerEvent[] = [];
  const keys: Array<{ keysym: number; down: boolean }> = [];
  const authResponses: Buffer[] = [];
  const events = new EventEmitter();
  let connections = 0;

  const rect = (x: number, y: number, w: number, h: number) => {
    const data = Buffer.alloc(12 + w * h * 4);
    data.writeUInt16BE(x, 0); data.writeUInt16BE(y, 2); data.writeUInt16BE(w, 4); data.writeUInt16BE(h, 6);
    data.writeInt32BE(0, 8);
    for (let row = 0; row < h; row++) {
      framebuffer.copy(data, 12 + row * w * 4, ((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4);
    }
    return data;
  };
  const update = (socket: WebSocket, rects: Buffer[]) => {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(rects.length, 2);
    socket.send(Buffer.concat([header, ...rects]));
  };

  sockets.on("connection", socket => {
    connections++;
    let pending = Buffer.alloc(0);
    let phase = 0;
    let waiting = false;
    let lastButtons = 0;
    const dirty: Array<[number, number, number, number]> = [];
    const flushDirty = () => {
      if (!waiting || !dirty.length) return;
      waiting = false;
      update(socket, dirty.splice(0).map(([x, y, w, h]) => rect(x, y, w, h)));
    };
    socket.send(Buffer.from("RFB 003.008\n"));
    socket.on("message", raw => {
      pending = Buffer.concat([pending, Buffer.from(raw as Buffer)]);
      for (;;) {
        let length: number;
        if (phase === 0) length = 12;
        else if (phase === 1) length = 1;
        else if (phase === 2) length = 16;
        else if (phase === 3) length = 1;
        else {
          if (!pending.length) return;
          switch (pending[0]) {
            case 0: length = 20; break;
            case 2: if (pending.length < 4) return; length = 4 + pending.readUInt16BE(2) * 4; break;
            case 3: length = 10; break;
            case 4: length = 8; break;
            case 5: length = 6; break;
            case 6: if (pending.length < 8) return; length = 8 + pending.readUInt32BE(4); break;
            default: socket.close(); return;
          }
        }
        if (pending.length < length) return;
        const message = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (phase === 0) {
          phase = 1;
          socket.send(Buffer.from([1, 2])); // VNC authentication only
        } else if (phase === 1) {
          if (message[0] !== 2) { socket.close(); return; }
          phase = 2;
          socket.send(Buffer.alloc(16, 0x5a)); // the challenge
        } else if (phase === 2) {
          // The client's DES answer is recorded, not checked: the fixture
          // proves the client authenticates, not that DES works.
          authResponses.push(Buffer.from(message));
          phase = 3;
          socket.send(Buffer.alloc(4)); // SecurityResult OK
        } else if (phase === 3) {
          phase = 4;
          const name = Buffer.from("Isolated Local VM");
          const init = Buffer.alloc(24 + name.length);
          init.writeUInt16BE(width, 0); init.writeUInt16BE(height, 2);
          init[4] = 32; init[5] = 24; init[7] = 1;
          init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12);
          init[14] = 16; init[15] = 8;
          init.writeUInt32BE(name.length, 20); name.copy(init, 24);
          socket.send(init);
        } else if (message[0] === 3) {
          if (message[1] === 0) update(socket, [rect(0, 0, width, height)]);
          else { waiting = true; flushDirty(); }
        } else if (message[0] === 4) {
          const event = { keysym: message.readUInt32BE(4), down: message[1] === 1 };
          keys.push(event);
          events.emit("key", event);
        } else if (message[0] === 5) {
          const event = { buttons: message[1], x: message.readUInt16BE(2), y: message.readUInt16BE(4) };
          pointer.push(event);
          events.emit("pointer", event);
          // A left press paints a marker where it landed.
          if (event.buttons & 1 && !(lastButtons & 1)) {
            const size = 24;
            const x0 = Math.max(0, Math.min(width - size, event.x - size / 2));
            const y0 = Math.max(0, Math.min(height - size, event.y - size / 2));
            for (let y = y0; y < y0 + size; y++) {
              for (let x = x0; x < x0 + size; x++) {
                const at = (y * width + x) * 4;
                framebuffer[at] = 0x3f; framebuffer[at + 1] = 0x8c; framebuffer[at + 2] = 0xff;
              }
            }
            dirty.push([x0, y0, size, size]);
            flushDirty();
          }
          lastButtons = event.buttons;
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    pointer,
    keys,
    authResponses,
    connections: () => connections,
    /** Typed characters, from key-down events in the printable range. */
    typed: () => keys.filter(k => k.down && k.keysym >= 0x20 && k.keysym <= 0xff).map(k => String.fromCharCode(k.keysym)).join(""),
    nextPointer: () => once(events, "pointer", { signal: AbortSignal.timeout(10_000) }),
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
