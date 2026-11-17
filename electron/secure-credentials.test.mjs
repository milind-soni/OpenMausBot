import { describe, expect, it, vi } from "vitest";

import { installCredentialStoreIpc, readSecureCredentials, resetUnreadableCredentials } from "./secure-credentials.mjs";

const transient = () =>
  new Error("safeStorage.decryptStringAsync is temporarily unavailable. Please try again.");

const deps = (over = {}) => ({
  exists: () => true,
  isAvailable: async () => true,
  readFile: () => Buffer.from("cipher"),
  decrypt: async () => JSON.stringify({ composioApiKey: "ak_live" }),
  sleep: async () => {},
  ...over,
});

describe("readSecureCredentials", () => {
  it("reports an empty store when no file was ever written", async () => {
    const result = await readSecureCredentials(deps({ exists: () => false }));
    expect(result).toEqual({ status: "empty", credentials: {} });
  });

  it("returns the stored credentials when the store opens", async () => {
    const result = await readSecureCredentials(deps());
    expect(result.status).toBe("ok");
    expect(result.credentials).toEqual({ composioApiKey: "ak_live" });
  });

  it("tries again when the OS says the store is temporarily unavailable", async () => {
    const decrypt = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue(JSON.stringify({ composioApiKey: "ak_live" }));
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(decrypt).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("ok");
    expect(result.credentials).toEqual({ composioApiKey: "ak_live" });
  });

  it("waits between attempts instead of hammering the keychain", async () => {
    const slept = [];
    const decrypt = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue("{}");
    await readSecureCredentials(deps({ decrypt, sleep: async (ms) => slept.push(ms) }));
    expect(slept).toEqual([100]);
  });

  it("says UNAVAILABLE — never empty — when every attempt fails", async () => {
    const decrypt = vi.fn().mockRejectedValue(transient());
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(result.status).toBe("unavailable");
    expect(result.credentials).toEqual({});
    expect(result.error).toMatch(/temporarily unavailable/);
    expect(decrypt.mock.calls.length).toBeGreaterThan(1);
  });

  it("says UNAVAILABLE when the OS store itself is switched off", async () => {
    const result = await readSecureCredentials(deps({ isAvailable: async () => false }));
    expect(result.status).toBe("unavailable");
  });

  it("says UNAVAILABLE for a file it cannot parse, rather than pretending it is empty", async () => {
    const decrypt = vi.fn().mockResolvedValue("not json");
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(result.status).toBe("unavailable");
    expect(decrypt).toHaveBeenCalledTimes(1);
  });
});

describe("resetUnreadableCredentials", () => {
  const resetDeps = (over = {}) => ({
    unreadable: true,
    confirm: vi.fn(async () => true),
    quitting: () => false,
    moveAside: vi.fn(),
    failed: vi.fn(async () => {}),
    restart: vi.fn(),
    ...over,
  });

  it("moves the unreadable file aside and restarts once the person confirms", async () => {
    const d = resetDeps();
    await expect(resetUnreadableCredentials(d)).resolves.toBe("reset");
    expect(d.moveAside).toHaveBeenCalledTimes(1);
    expect(d.restart).toHaveBeenCalledTimes(1);
  });

  it("never touches a store that was read, and does not even ask", async () => {
    const d = resetDeps({ unreadable: false });
    await expect(resetUnreadableCredentials(d)).resolves.toBe("readable");
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.moveAside).not.toHaveBeenCalled();
    expect(d.restart).not.toHaveBeenCalled();
  });

  it("moves nothing when the app began to quit while the person was deciding", async () => {
    const d = resetDeps({ quitting: () => true });
    await expect(resetUnreadableCredentials(d)).resolves.toBe("quitting");
    expect(d.moveAside).not.toHaveBeenCalled();
    expect(d.restart).not.toHaveBeenCalled();
  });

  it("changes nothing when the person cancels", async () => {
    const d = resetDeps({ confirm: vi.fn(async () => false) });
    await expect(resetUnreadableCredentials(d)).resolves.toBe("cancelled");
    expect(d.moveAside).not.toHaveBeenCalled();
    expect(d.restart).not.toHaveBeenCalled();
  });

  it("tells the person and does not restart when the file cannot be moved aside", async () => {
    const busy = new Error("EBUSY: resource busy or locked");
    const d = resetDeps({ moveAside: vi.fn(() => { throw busy; }) });
    await expect(resetUnreadableCredentials(d)).resolves.toBe("failed");
    expect(d.failed).toHaveBeenCalledWith(busy);
    expect(d.restart).not.toHaveBeenCalled();
  });

  it("still restarts when the file is already gone", async () => {
    const gone = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    const d = resetDeps({ moveAside: vi.fn(() => { throw gone; }) });
    await expect(resetUnreadableCredentials(d)).resolves.toBe("reset");
    expect(d.failed).not.toHaveBeenCalled();
    expect(d.restart).toHaveBeenCalledTimes(1);
  });

  it("reports a folder it can no longer read instead of restarting as if the file were gone", async () => {
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const d = resetDeps({ moveAside: vi.fn(() => { throw denied; }) });
    await expect(resetUnreadableCredentials(d)).resolves.toBe("failed");
    expect(d.failed).toHaveBeenCalledWith(denied);
    expect(d.restart).not.toHaveBeenCalled();
  });
});

describe("installCredentialStoreIpc", () => {
  const installed = (over = {}) => {
    const handlers = new Map();
    const deps = {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      localOnly: vi.fn((channel, handler) => handler),
      dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
      windowFor: () => null,
      t: (key) => key,
      appName: () => "OpenMausBot",
      unreadable: () => true,
      quitting: () => false,
      moveAside: vi.fn(),
      log: vi.fn(),
      relaunch: vi.fn(),
      ...over,
    };
    installCredentialStoreIpc(deps);
    return { handlers, deps };
  };

  it("guards both calls as this app's own page only", () => {
    const { deps } = installed();
    expect(deps.localOnly.mock.calls.map(([channel]) => channel)).toEqual(["credential-store:unreadable", "credential-store:reset"]);
  });

  it("answers from the launch read's current result, not one captured at install", async () => {
    let unreadable = false;
    const { handlers, deps } = installed({ unreadable: () => unreadable });
    expect(handlers.get("credential-store:unreadable")()).toBe(false);
    await expect(handlers.get("credential-store:reset")({ sender: {} })).resolves.toBe("readable");
    expect(deps.dialog.showMessageBox).not.toHaveBeenCalled();
    unreadable = true;
    expect(handlers.get("credential-store:unreadable")()).toBe(true);
    await expect(handlers.get("credential-store:reset")({ sender: {} })).resolves.toBe("reset");
  });

  it("moves nothing when the person cancels", async () => {
    const { handlers, deps } = installed({ dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) } });
    await expect(handlers.get("credential-store:reset")({ sender: {} })).resolves.toBe("cancelled");
    expect(deps.moveAside).not.toHaveBeenCalled();
    expect(deps.relaunch).not.toHaveBeenCalled();
  });

  it("asks over the window that asked, moves the file aside and relaunches on yes", async () => {
    const win = { id: 7 };
    const { handlers, deps } = installed({ windowFor: () => win });
    await expect(handlers.get("credential-store:reset")({ sender: {} })).resolves.toBe("reset");
    expect(deps.dialog.showMessageBox).toHaveBeenCalledWith(win, expect.objectContaining({ message: "native.dialog.resetSavedKeys.title", cancelId: 1, defaultId: 1 }));
    expect(deps.moveAside).toHaveBeenCalledTimes(1);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
  });

  it("tells the person and stays put when the file cannot be moved aside", async () => {
    const busy = new Error("EBUSY: resource busy or locked");
    const { handlers, deps } = installed({ moveAside: () => { throw busy; } });
    await expect(handlers.get("credential-store:reset")({ sender: {} })).resolves.toBe("failed");
    expect(deps.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ type: "error", message: "native.dialog.resetSavedKeys.failed", detail: busy.message }));
    expect(deps.relaunch).not.toHaveBeenCalled();
  });
});
