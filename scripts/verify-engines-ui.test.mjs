import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  launch: vi.fn(), createServer: vi.fn(), close: vi.fn(),
  listen: vi.fn(), closeUi: vi.fn(), closeHttp: vi.fn(), closeConnections: vi.fn(), signals: new Map(),
}));
vi.mock("./control-omb.ts", () => ({ launchVerificationServer: fixture.launch }));
vi.mock("vite", () => ({ createServer: fixture.createServer }));
vi.mock("node:http", () => ({ createServer: () => ({
  on: vi.fn(), once: vi.fn(), removeListener: vi.fn(), listen: fixture.listen,
  close: fixture.closeHttp, closeAllConnections: fixture.closeConnections, address: () => ({ port: 2 }),
}) }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  fixture.signals.clear();
  const once = process.once;
  vi.spyOn(process, "once").mockImplementation(function (event, listener) {
    if (event === "SIGINT" || event === "SIGTERM") {
      fixture.signals.set(event, listener);
      return this;
    }
    return once.call(this, event, listener);
  });
  vi.spyOn(process, "removeListener");
  vi.spyOn(console, "log").mockImplementation(() => {});
  fixture.launch.mockResolvedValue({
    info: { dataDir: "/fixture-only", url: "http://127.0.0.1:1" }, close: fixture.close,
  });
  fixture.createServer.mockResolvedValue({
    middlewares: vi.fn(), close: fixture.closeUi,
  });
  fixture.listen.mockImplementation((_port, _host, ready) => ready());
  fixture.closeHttp.mockImplementation(closed => closed());
});
afterEach(() => vi.restoreAllMocks());

function expectSignalsRemoved() {
  for (const [event, handler] of fixture.signals) {
    expect(process.removeListener).toHaveBeenCalledWith(event, handler);
  }
}

it("registers cancellation before launch and removes handlers if startup aborts", async () => {
  fixture.launch.mockImplementation(async (env, signal) => {
    expect(env).toBe(process.env);
    expect([...fixture.signals.keys()]).toEqual(["SIGINT", "SIGTERM"]);
    fixture.signals.get("SIGINT")();
    expect(signal.aborted).toBe(true);
    throw new Error("verification launch cancelled");
  });
  await expect(import("./verify-engines-ui.ts")).rejects.toThrow("verification launch cancelled");
  expect(fixture.createServer).not.toHaveBeenCalled();
  expectSignalsRemoved();
});

it("closes the isolated fixture when UI creation fails", async () => {
  fixture.createServer.mockRejectedValue(new Error("UI startup failed"));
  await expect(import("./verify-engines-ui.ts")).rejects.toThrow("UI startup failed");
  expect(fixture.close).toHaveBeenCalledOnce();
  expectSignalsRemoved();
});

it("uses the same cancellation signal after startup", async () => {
  const run = import("./verify-engines-ui.ts");
  await vi.waitFor(() => expect(fixture.listen).toHaveBeenCalledOnce());
  fixture.signals.get("SIGTERM")();
  await run;
  expect(fixture.launch.mock.calls[0][1].aborted).toBe(true);
  expect(fixture.closeUi).toHaveBeenCalledOnce();
  expect(fixture.closeHttp).toHaveBeenCalledOnce();
  expect(fixture.closeConnections).toHaveBeenCalledOnce();
  expect(fixture.close).toHaveBeenCalledOnce();
  expectSignalsRemoved();
});

it("stops the app and deletes fixture data before waiting on Vite shutdown", async () => {
  let releaseHttp;
  let releaseFixture;
  let releaseUi;
  fixture.closeHttp.mockImplementationOnce(closed => { releaseHttp = closed; });
  fixture.close.mockImplementationOnce(() => new Promise(resolve => { releaseFixture = resolve; }));
  fixture.closeUi.mockImplementationOnce(() => new Promise(resolve => { releaseUi = resolve; }));
  const run = import("./verify-engines-ui.ts");
  await vi.waitFor(() => expect(fixture.listen).toHaveBeenCalledOnce());
  const server = fixture.createServer.mock.calls[0][0].server;
  expect(server.middlewareMode.server).toBe(server.hmr.server);
  fixture.signals.get("SIGTERM")();
  await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
  expect(fixture.closeHttp).toHaveBeenCalledOnce();
  expect(fixture.closeUi).not.toHaveBeenCalled();
  releaseFixture();
  await vi.waitFor(() => expect(fixture.closeUi).toHaveBeenCalledOnce());
  releaseUi();
  releaseHttp();
  await run;
  expect(fixture.close).toHaveBeenCalledOnce();
});

it("does not miss cancellation during UI startup or skip fixture cleanup if UI close fails", async () => {
  fixture.listen.mockImplementation((_port, _host, ready) => { fixture.signals.get("SIGINT")(); ready(); });
  fixture.closeUi.mockRejectedValue(new Error("UI close failed"));
  await expect(import("./verify-engines-ui.ts")).rejects.toThrow("UI close failed");
  expect(fixture.close).toHaveBeenCalledOnce();
  expectSignalsRemoved();
});
