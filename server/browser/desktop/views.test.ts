import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Duplex } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { DESKTOP_CLOSE, DesktopViews, type DesktopRequest, type DesktopTarget } from "./views.ts";

const HANDSHAKE = Buffer.concat([Buffer.from("RFB 003.008\n", "latin1"), Buffer.from([1, 1])]);
const key = (down: boolean, keysym: number) => { const message = Buffer.alloc(8); message[0] = 4; message[1] = down ? 1 : 0; message.writeUInt32BE(keysym, 4); return message; };
const pointer = (mask: number, x: number, y: number) => { const message = Buffer.alloc(6); message[0] = 5; message[1] = mask; message.writeUInt16BE(x, 2); message.writeUInt16BE(y, 4); return message; };
const updateRequest = () => Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const desktopSize = (width: number, height: number) => { const message = Buffer.alloc(8 + 16); message[0] = 251; message.writeUInt16BE(width, 2); message.writeUInt16BE(height, 4); message[6] = 1; message.writeUInt16BE(width, 16); message.writeUInt16BE(height, 18); return message; };

class Display extends Duplex {
  readonly received: Buffer[] = [];
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.received.push(chunk);
    done();
  }
  bytes(): Buffer {
    return Buffer.concat(this.received);
  }
}

class Control {
  owner: string | null = null;
  ready = false;
  readonly #listeners = new Set<() => void>();
  canControl(owner: string): boolean { return this.owner === owner && this.ready; }
  onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  set(owner: string | null, ready = owner !== null): void {
    this.owner = owner;
    this.ready = ready;
    for (const listener of this.#listeners) listener();
  }
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function harness(options: { desktop?: boolean; stopped?: boolean; person?: string; canOperate?: boolean } = {}) {
  const display = new Display();
  const control = new Control();
  let used = 0;
  let current = true;
  const resizes: Array<[number, number]> = [];
  const target: DesktopTarget = { socket: "/unused", control, used: () => { used++; }, resized: (width, height) => { resizes.push([width, height]); } };
  const views = new DesktopViews({ desktop: async () => (options.desktop === false ? "pictures" : options.stopped ? "stopped" : target), connectSocket: () => display });
  const server = createServer();
  servers.push(server);
  server.on("upgrade", (req, socket, head) => {
    const request: DesktopRequest = {
      target: { session: "s", key: "bot:a" }, botId: "a", owner: "session-1", person: options.person ?? "alice",
      canOperate: options.canOperate ?? true, req, socket: socket as Socket, head, isCurrent: () => current,
    };
    views.open(request);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const fromDisplay: Buffer[] = [];
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  ws.on("message", (data) => fromDisplay.push(Buffer.from(data as Buffer)));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return { ws, display, control, views, closed, fromDisplay, resizes, used: () => used, setCurrent: (value: boolean) => { current = value; } };
}

/** Waits until `check` holds; what must not happen is checked behind a message the display does receive. */
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !check(); await new Promise((resolve) => setTimeout(resolve, 10))) {
    if (Date.now() > deadline) throw new Error("timed out");
  }
}
const endsWith = (display: Display, bytes: Buffer) => {
  const all = display.bytes();
  return all.length >= bytes.length && all.subarray(all.length - bytes.length).equals(bytes);
};

describe("desktop views", () => {
  it("shows the display to a watcher and drops its pointer and keys", async () => {
    const { ws, display, fromDisplay, used } = await harness();
    ws.send(Buffer.concat([HANDSHAKE, pointer(1, 5, 5), key(true, 0x61), updateRequest()]));
    await until(() => endsWith(display, updateRequest()));
    expect(display.bytes().equals(Buffer.concat([HANDSHAKE, updateRequest()]))).toBe(true);
    display.push(Buffer.from("RFB 003.008\n"));
    await until(() => Buffer.concat(fromDisplay).length === 12);
    expect(Buffer.concat(fromDisplay).toString()).toBe("RFB 003.008\n");
    expect(used()).toBe(0);
    ws.close();
  });

  it("passes the person's input once they hold the browser, and counts it as use", async () => {
    const { ws, display, control, used } = await harness();
    control.set("alice");
    const input = Buffer.concat([HANDSHAKE, pointer(1, 5, 5), pointer(0, 5, 5), key(true, 0x61), key(false, 0x61)]);
    ws.send(input);
    await until(() => display.bytes().length === input.length);
    expect(display.bytes().equals(input)).toBe(true);
    expect(used()).toBe(1);
    ws.close();
  });

  it("waits for the takeover to drain the bot's work before passing input", async () => {
    const { ws, display, control } = await harness();
    control.set("alice", false);
    ws.send(Buffer.concat([HANDSHAKE, key(true, 0x61), updateRequest()]));
    await until(() => endsWith(display, updateRequest()));
    expect(display.bytes().equals(Buffer.concat([HANDSHAKE, updateRequest()]))).toBe(true);
    ws.close();
  });

  it("lets go of what the person held when they hand the browser back", async () => {
    const { ws, display, control } = await harness();
    control.set("alice");
    const held = Buffer.concat([HANDSHAKE, key(true, 0x61), pointer(1, 9, 9)]);
    ws.send(held);
    await until(() => display.bytes().length === held.length);
    display.received.length = 0;
    control.set(null);
    const release = Buffer.concat([key(false, 0x61), pointer(0, 9, 9)]);
    await until(() => display.bytes().length >= release.length);
    expect(display.bytes().equals(release)).toBe(true);
    ws.send(Buffer.concat([key(true, 0x62), updateRequest()]));
    await until(() => endsWith(display, updateRequest()));
    expect(display.bytes().equals(Buffer.concat([release, updateRequest()]))).toBe(true);
    ws.close();
  });

  it("lets only the person holding the browser resize the display, within limits, and fits the window to it", async () => {
    const { ws, display, control, resizes } = await harness();
    ws.send(Buffer.concat([HANDSHAKE, desktopSize(900, 700), updateRequest()]));
    await until(() => endsWith(display, updateRequest()));
    expect(resizes).toEqual([]);
    control.set("alice");
    ws.send(Buffer.concat([desktopSize(400, 750), updateRequest()]));
    await until(() => resizes.length === 1);
    expect(resizes).toEqual([[1280, 2400]]);
    const sent = display.bytes().subarray(HANDSHAKE.length + 10, HANDSHAKE.length + 10 + 24);
    expect([sent.readUInt16BE(2), sent.readUInt16BE(4), sent.readUInt16BE(16), sent.readUInt16BE(18)]).toEqual([1280, 2400, 1280, 2400]);
    ws.close();
  });

  it("never drives from a passive view", async () => {
    const { ws, display, control } = await harness({ canOperate: false });
    control.set("alice");
    ws.send(Buffer.concat([HANDSHAKE, key(true, 0x61), updateRequest()]));
    await until(() => endsWith(display, updateRequest()));
    expect(display.bytes().equals(Buffer.concat([HANDSHAKE, updateRequest()]))).toBe(true);
    ws.close();
  });

  it("closes, showing nothing more, when another person takes the browser", async () => {
    const { ws, display, control, closed, fromDisplay } = await harness();
    ws.send(HANDSHAKE);
    await until(() => display.bytes().length === HANDSHAKE.length);
    control.set("bob");
    display.push(Buffer.from("pixels"));
    expect(await closed).toBe(DESKTOP_CLOSE.heldElsewhere);
    expect(fromDisplay).toHaveLength(0);
  });

  it("refuses to open while another person holds the browser", async () => {
    const first = await harness();
    first.ws.close();
    const second = await harness();
    second.control.set("bob");
    second.ws.send(HANDSHAKE);
    expect(await second.closed).toBe(DESKTOP_CLOSE.heldElsewhere);
  });

  it("closes a view whose person may no longer see the browser", async () => {
    const { ws, display, closed, setCurrent } = await harness();
    setCurrent(false);
    ws.send(Buffer.concat([HANDSHAKE, key(true, 0x61)]));
    expect(await closed).toBe(DESKTOP_CLOSE.gone);
    expect(display.bytes().length).toBe(0);
  });

  it("closes on a browser that runs without a display, so the panel shows pictures", async () => {
    const { closed } = await harness({ desktop: false });
    expect(await closed).toBe(DESKTOP_CLOSE.pictures);
  });

  it("closes, without starting anything, on a browser that is not running", async () => {
    const { closed, display } = await harness({ stopped: true });
    expect(await closed).toBe(DESKTOP_CLOSE.gone);
    expect(display.bytes().length).toBe(0);
  });

  it("closes on anything that is not RFB", async () => {
    const text = await harness();
    text.ws.send("hello");
    expect(await text.closed).toBe(DESKTOP_CLOSE.protocol);
    const garbage = await harness();
    garbage.ws.send(Buffer.concat([HANDSHAKE, Buffer.from([99])]));
    expect(await garbage.closed).toBe(DESKTOP_CLOSE.protocol);
  });

  it("closes when the display goes", async () => {
    const { display, closed } = await harness();
    display.destroy();
    expect(await closed).toBe(DESKTOP_CLOSE.gone);
  });

  it("closes a bot's views on request", async () => {
    const { views, closed } = await harness();
    views.closeForBot("a");
    expect(await closed).toBe(DESKTOP_CLOSE.gone);
  });
});
