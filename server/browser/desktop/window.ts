// The browser's windows on a private display follow the display's size: with no window manager, nothing else moves or
// resizes them when a person's view resizes the display.
import { connect } from "node:net";

import type { CdpBrowser } from "../cdp/browser.ts";

/** Each window of `browser` fills the display from its top left corner. */
export async function fillDisplay(browser: Pick<CdpBrowser, "connection" | "pages">, size: { width: number; height: number }): Promise<void> {
  const root = browser.connection.root;
  const windows = new Set<number>();
  for (const page of browser.pages()) {
    const found = await root.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId: page.targetId }).catch(() => null);
    if (found) windows.add(found.windowId);
  }
  for (const windowId of windows) {
    // Chrome sets a size only on a window in its normal state.
    await root.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }).catch(() => undefined);
    await root.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width: size.width, height: size.height } }).catch(() => undefined);
  }
}

/** Asks the display server for a new size over its own RFB socket, as a viewer would: used to give the bot back the
 * display's usual size once the person who resized it hands the browser back. */
export async function resizeDisplay(socket: string, size: { width: number; height: number }, timeoutMs = 5_000): Promise<void> {
  const connection = connect(socket);
  let buffer = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  connection.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); wake?.(); });
  const closed = new Promise<void>((resolve) => connection.once("close", () => resolve()));
  connection.on("error", () => wake?.());
  const deadline = Date.now() + timeoutMs;
  const read = async (bytes: number): Promise<Buffer> => {
    while (buffer.length < bytes) {
      if (connection.destroyed || Date.now() > deadline) throw new Error("The display did not answer.");
      await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 50).unref(); });
    }
    const out = buffer.subarray(0, bytes);
    buffer = buffer.subarray(bytes);
    return out;
  };
  try {
    await read(12);
    connection.write("RFB 003.008\n");
    await read((await read(1))[0]!);
    connection.write(Buffer.from([1]));
    await read(4);
    connection.write(Buffer.from([1]));
    const init = await read(24);
    await read(init.readUInt32BE(20));
    const encodings = Buffer.alloc(8);
    encodings[0] = 2;
    encodings.writeUInt16BE(1, 2);
    encodings.writeInt32BE(-308, 4);
    const resize = Buffer.alloc(8 + 16);
    resize[0] = 251;
    resize.writeUInt16BE(size.width, 2);
    resize.writeUInt16BE(size.height, 4);
    resize[6] = 1;
    resize.writeUInt16BE(size.width, 16);
    resize.writeUInt16BE(size.height, 18);
    connection.end(Buffer.concat([encodings, resize]));
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
  } finally {
    connection.destroy();
  }
}
