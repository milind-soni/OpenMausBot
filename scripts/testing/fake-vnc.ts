// An offline RFB 3.8 desktop for the real noVNC renderer. No host display,
// container daemon or network outside loopback is used.
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { WebSocketServer } from "ws";

export async function fakeVnc() {
  const server = createServer((_req, res) => res.writeHead(404).end());
  const sockets = new WebSocketServer({ server, path: "/websockify" });
  const keys: number[] = [];
  const events = new EventEmitter();
  let connections = 0;
  sockets.on("connection", socket => {
    connections++;
    let pending: Buffer = Buffer.alloc(0);
    let phase = 0;
    let sentFrame = false;
    socket.send(Buffer.from("RFB 003.008\n"));
    const frame = () => {
      const data = Buffer.alloc(4 + 12 + 16 * 16 * 4);
      data.writeUInt16BE(1, 2); // one raw rectangle
      data.writeUInt16BE(16, 8); data.writeUInt16BE(16, 10);
      // noVNC requests little-endian RGBX in SetPixelFormat.
      for (let i = 16; i < data.length; i += 4) data[i] = 255;
      socket.send(data);
    };
    socket.on("message", raw => {
      pending = Buffer.concat([pending, Buffer.from(raw as Buffer)]);
      for (;;) {
        let length: number;
        if (phase === 0) length = 12;
        else if (phase <= 2) length = 1;
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
        if (phase === 0) { phase++; socket.send(Buffer.from([1, 1])); }
        else if (phase === 1) { phase++; socket.send(Buffer.alloc(4)); }
        else if (phase === 2) {
          phase++;
          const name = Buffer.from("Isolated test desktop");
          const init = Buffer.alloc(24 + name.length);
          init.writeUInt16BE(16, 0); init.writeUInt16BE(16, 2);
          init[4] = 32; init[5] = 24; init[7] = 1;
          init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12);
          init[14] = 16; init[15] = 8;
          init.writeUInt32BE(name.length, 20); name.copy(init, 24);
          socket.send(init);
        } else if (message[0] === 3 && !sentFrame) { sentFrame = true; frame(); }
        else if (message[0] === 4 && message[1] === 1) {
          const key = message.readUInt32BE(4);
          keys.push(key);
          events.emit("key", key);
        }
        else if (message[0] === 6) {
          const text = message.subarray(8).toString("latin1");
          events.emit("clipboard", text);
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port, keys,
    nextClipboard: () => once(events, "clipboard", { signal: AbortSignal.timeout(10_000) }),
    async untilKey(key: number) {
      const signal = AbortSignal.timeout(10_000);
      while (!keys.includes(key)) await once(events, "key", { signal });
    },
    sendClipboard(text: string) {
      const bytes = Buffer.from(text, "latin1");
      const message = Buffer.alloc(8 + bytes.length);
      message[0] = 3;
      message.writeUInt32BE(bytes.length, 4);
      bytes.copy(message, 8);
      for (const socket of sockets.clients) socket.send(message);
    },
    connections: () => connections,
    nextConnection: () => once(sockets, "connection", { signal: AbortSignal.timeout(10_000) }),
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
