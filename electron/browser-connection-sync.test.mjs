import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { postBrowserConnection, removeBrowserConnectionDescriptor } = require("./browser-connection-sync.cjs");

describe("packaged browser connection transport", () => {
  it("removes only the stale browser descriptor and tolerates a clean install", () => {
    const unlinkSync = vi.fn();
    expect(removeBrowserConnectionDescriptor({ userData: "/app/user-data", fileSystem: { unlinkSync } })).toBe(true);
    expect(unlinkSync).toHaveBeenCalledWith(path.join("/app/user-data", "browser-connection.json"));

    unlinkSync.mockImplementationOnce(() => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    });
    expect(removeBrowserConnectionDescriptor({ userData: "/app/user-data", fileSystem: { unlinkSync } })).toBe(false);
  });

  it("posts the in-memory descriptor or an explicit unavailable marker", () => {
    const proc = { postMessage: vi.fn() };
    const connection = { version: 1, url: "http://127.0.0.1:54321", token: "a".repeat(64), pid: 42 };
    postBrowserConnection(proc, connection);
    postBrowserConnection(proc, null);
    expect(proc.postMessage).toHaveBeenNthCalledWith(1, { type: "openmausbot:browser-connection", connection });
    expect(proc.postMessage).toHaveBeenNthCalledWith(2, { type: "openmausbot:browser-connection", connection: null });
  });
});
