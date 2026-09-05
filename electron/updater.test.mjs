import { afterEach, expect, it, vi } from "vitest";
import localOriginModule from "./local-origin.cjs";

// The updater channels answer only the local UI (electron/local-origin.cjs).
localOriginModule.setLocalOrigin("http://127.0.0.1:8799");
const localEvent = { senderFrame: { url: "http://127.0.0.1:8799/" } };

const { updater, handlers } = vi.hoisted(() => ({
  updater: { on: vi.fn(), downloadUpdate: vi.fn() },
  handlers: new Map(),
}));

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused-updater-test-log" },
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
}));
vi.mock("node:module", () => ({
  createRequire: () => () => ({ autoUpdater: updater }),
}));

const { attachUpdaterWindow, registerUpdaterIpc, startUpdater } = await import("./updater.mjs");

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("sends updater progress to a reopened window without restarting the updater", async () => {
  vi.useFakeTimers();
  const first = { webContents: { send: vi.fn() } };
  const reopened = { webContents: { send: vi.fn() } };
  attachUpdaterWindow(first);
  registerUpdaterIpc();
  startUpdater();
  const listenerCount = updater.on.mock.calls.length;
  const timerCount = vi.getTimerCount();

  first.webContents.send.mockImplementation(() => { throw new Error("window destroyed"); });
  first.webContents.send.mockClear();
  attachUpdaterWindow(reopened);
  const emit = (name, payload) => {
    for (const [event, listener] of updater.on.mock.calls) {
      if (event === name) listener(payload);
    }
  };
  updater.downloadUpdate.mockImplementation(async () => {
    emit("download-progress", { percent: 50 });
    emit("update-downloaded", { version: "2.0.0" });
    return ["/unused-staged-update.zip"];
  });

  await handlers.get("update:download")(localEvent);

  expect(first.webContents.send).not.toHaveBeenCalled();
  expect(reopened.webContents.send.mock.calls.map(([, state]) => state.status))
    .toEqual(["downloading", "downloading", "downloaded"]);
  expect(handlers.get("update:get-state")(localEvent)).toMatchObject({ status: "downloaded", version: "2.0.0" });
  expect(updater.on.mock.calls).toHaveLength(listenerCount);
  expect(vi.getTimerCount()).toBe(timerCount);
});
