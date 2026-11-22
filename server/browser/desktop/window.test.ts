import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fillDisplay, resizeDisplay } from "./window.ts";

describe("windows on a private display", () => {
  it("brings each window to its normal state and makes it fill the display from the corner", async () => {
    const sent: Array<{ method: string; params: unknown }> = [];
    const root = {
      send: async (method: string, params: { targetId?: string }) => {
        sent.push({ method, params });
        return method === "Browser.getWindowForTarget" ? { windowId: params.targetId === "c" ? 2 : 1 } : {};
      },
    };
    const browser = { connection: { root }, pages: () => [{ targetId: "a" }, { targetId: "b" }, { targetId: "c" }] } as unknown as Parameters<typeof fillDisplay>[0];
    await fillDisplay(browser, { width: 1600, height: 900 });
    expect(sent.filter((call) => call.method === "Browser.setWindowBounds").map((call) => call.params)).toEqual([
      { windowId: 1, bounds: { windowState: "normal" } },
      { windowId: 1, bounds: { left: 0, top: 0, width: 1600, height: 900 } },
      { windowId: 2, bounds: { windowState: "normal" } },
      { windowId: 2, bounds: { left: 0, top: 0, width: 1600, height: 900 } },
    ]);
  });
});

describe("giving the display its usual size back", () => {
  it.skipIf(process.platform === "win32")("asks the display server for it over the RFB socket, as a viewer would", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-rfb-"));
    const socket = join(dir, "rfb");
    const received: Buffer[] = [];
    const ended = new Promise<void>((resolve) => {
      const server = createServer((client) => {
        client.write("RFB 003.008\n");
        client.on("data", (chunk: Buffer) => {
          received.push(chunk);
          const sent = Buffer.concat(received);
          if (sent.length === 12) client.write(Buffer.from([1, 1]));
          if (sent.length === 13) client.write(Buffer.alloc(4));
          if (sent.length === 14) {
            const init = Buffer.alloc(24);
            init.writeUInt16BE(1600, 0);
            init.writeUInt16BE(900, 2);
            client.write(init);
          }
        });
        client.on("end", () => { server.close(); resolve(); });
      }).listen(socket);
    });
    try {
      await resizeDisplay(socket, { width: 1280, height: 800 });
      await ended;
      const sent = Buffer.concat(received);
      expect(sent.subarray(0, 12).toString("latin1")).toBe("RFB 003.008\n");
      const resize = sent.subarray(sent.length - 24);
      expect([resize[0], resize.readUInt16BE(2), resize.readUInt16BE(4), resize[6], resize.readUInt16BE(16), resize.readUInt16BE(18)]).toEqual([251, 1280, 800, 1, 1280, 800]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
