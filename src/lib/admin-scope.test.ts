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
  await loadLimits(true);
  expect(api).toHaveBeenCalledTimes(1);
});

it("keeps asking after any other failure", async () => {
  api.mockRejectedValue(Object.assign(new Error("busy"), { status: 503 }));
  const { loadLimits } = await import("./limit-resets");
  await loadLimits();
  await loadLimits();
  expect(api).toHaveBeenCalledTimes(2);
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
