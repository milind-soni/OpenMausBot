import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), api }));

const refusal = () => Object.assign(new Error("forbidden: this session lacks the admin scope"), { status: 403 });

beforeEach(() => {
  vi.resetModules();
  api.mockReset();
});

it("stops asking for the engines' limits once the server says this session lacks the admin scope", async () => {
  api.mockRejectedValue(refusal());
  const { loadLimits } = await import("./limit-resets");
  await loadLimits();
  await loadLimits();
  expect(await loadLimits(true)).toBe(false);
  expect(api).toHaveBeenCalledTimes(1);
});

it("keeps asking after any other failure", async () => {
  api.mockRejectedValue(Object.assign(new Error("busy"), { status: 503 }));
  const { loadLimits } = await import("./limit-resets");
  await loadLimits();
  await loadLimits();
  expect(api).toHaveBeenCalledTimes(2);
});

it("reports a manual refresh failure while preserving the previous usage", async () => {
  const { loadLimits, rememberLimits, limitsCheckedAt } = await import("./limit-resets");
  rememberLimits({ checkedAt: 42, engines: [] });
  api.mockRejectedValue(new Error("fixture offline"));
  await expect(loadLimits(true)).rejects.toThrow("fixture offline");
  expect(limitsCheckedAt()).toBe(42);
});

it("ignores a background response that arrives after a newer manual refresh", async () => {
  const { loadLimits, limitsCheckedAt, limitRefreshError, limitWasChecked } = await import("./limit-resets");
  let finishBackground!: (value: unknown) => void;
  api.mockImplementationOnce(() => new Promise((resolve) => { finishBackground = resolve; }));
  const background = loadLimits();
  api.mockResolvedValueOnce({ checkedAt: 200, engines: [], checkedEngines: ["codex"] });
  await loadLimits(true);
  finishBackground({ checkedAt: 100, engines: [], errors: { codex: "Sign in again in Codex" } });
  await background;
  expect(limitsCheckedAt()).toBe(200);
  expect(limitRefreshError("codex")).toBeNull();
  expect(limitWasChecked("codex")).toBe(true);
});

it("shares simultaneous manual refreshes and does not start another poll while they run", async () => {
  const { loadLimits } = await import("./limit-resets");
  let finish!: (value: unknown) => void;
  api.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const first = loadLimits(true), second = loadLimits(true), poll = loadLimits();
  expect(api).toHaveBeenCalledExactlyOnceWith("/api/limit-resets?refresh=1");
  finish({ checkedAt: 42, engines: [] });
  expect(await Promise.all([first, second, poll])).toEqual([true, true, true]);
});

it("asks for the connected apps once, and answers a refused session's later reads from that", async () => {
  api.mockRejectedValue(refusal());
  const { preloadConnectedApps } = await import("@/components/PluginsPanel");
  expect(await preloadConnectedApps()).toEqual({ services: {}, authoritative: true, refused: true });
  expect(await preloadConnectedApps(true)).toEqual({ services: {}, authoritative: true, refused: true });
  expect(api).toHaveBeenCalledTimes(1);
});

it("answers a refused route's later reads without asking, and leaves other routes alone", async () => {
  const { unlessRefused } = await import("./admin-scope");
  const request = vi.fn().mockRejectedValue(refusal());
  expect(await unlessRefused("/api/instances", request, null)).toBeNull();
  expect(await unlessRefused("/api/instances", request, null)).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  expect(await unlessRefused("/api/live/call", async () => ({ call: null }), null)).toEqual({ call: null });
  await expect(unlessRefused("/api/live/call", async () => { throw new Error("offline"); }, null)).rejects.toThrow("offline");
});
