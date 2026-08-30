import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { clearBrowserPartitionSession } = require("./browser-partition-cleanup.cjs");

describe("browser partition cleanup", () => {
  it("does not confirm a wipe when the HTTP auth cache survives", async () => {
    const session = {
      closeAllConnections: vi.fn().mockResolvedValue(undefined),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
      clearAuthCache: vi.fn().mockRejectedValue(new Error("auth cache locked")),
    };

    await expect(clearBrowserPartitionSession(session)).rejects.toThrow("auth cache locked");
    expect(session.clearStorageData).toHaveBeenCalledOnce();
    expect(session.clearCache).toHaveBeenCalledOnce();
    expect(session.clearAuthCache).toHaveBeenCalledOnce();
    // The caller maps this rejection to ok:false; no post-cleanup success path
    // (including the final connection close) is reached.
    expect(session.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it("tolerates connection-close errors only after all durable caches clear", async () => {
    const session = {
      closeAllConnections: vi.fn().mockRejectedValue(new Error("already closed")),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
      clearAuthCache: vi.fn().mockResolvedValue(undefined),
    };

    await expect(clearBrowserPartitionSession(session)).resolves.toBeUndefined();
    expect(session.closeAllConnections).toHaveBeenCalledTimes(2);
  });
});
