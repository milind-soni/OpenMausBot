import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
let scripts: Array<{ src: string; onload: () => void; onerror: () => void }>;
let target: { fbq?: { queue: unknown[][] }; addEventListener: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_META_PIXEL_ID", "123456789");
  storage.clear();
  scripts = [];
  target = { addEventListener: vi.fn() };
  vi.stubGlobal("window", target);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("location", new URL("https://thenation.city/swarm/?utm_content=research"));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("document", {
    createElement: () => ({}),
    head: { appendChild: (script: (typeof scripts)[number]) => scripts.push(script) },
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("does not contact Meta before an explicit opt-in", async () => {
  const ads = await import("./ad-measurement");
  ads.startAdMeasurement();
  ads.recordNewRegistration(true);
  expect(scripts).toHaveLength(0);
  expect(storage.has("nation-new-registration-v1")).toBe(false);
});

it("sends a registration once after the redirect only for a newly created workspace", async () => {
  const ads = await import("./ad-measurement");
  ads.setAdMeasurementAllowed(true);
  scripts[0]!.onload();
  expect(target.fbq!.queue.filter((call) => call[2] === "CompleteRegistration")).toHaveLength(0);
  ads.recordNewRegistration(false);
  ads.recordNewRegistration(undefined);
  expect(storage.has("nation-new-registration-v1")).toBe(false);
  ads.recordNewRegistration(true);
  expect(storage.has("nation-new-registration-v1")).toBe(true);
  // New document after location.replace: consent and the pending event survive.
  vi.resetModules(); target = { addEventListener: vi.fn() }; vi.stubGlobal("window", target); scripts = [];
  const next = await import("./ad-measurement");
  next.startAdMeasurement(); scripts[0]!.onload(); next.startAdMeasurement();
  const events = target.fbq!.queue.filter((call) => call[2] === "CompleteRegistration");
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual(["trackSingle", "123456789", "CompleteRegistration", {}, { eventID: expect.any(String) }]);
  expect(storage.has("nation-new-registration-v1")).toBe(false);
});

it("loads once and disables automatic collection and advanced matching", async () => {
  const ads = await import("./ad-measurement");
  ads.setAdMeasurementAllowed(true); ads.startAdMeasurement();
  expect(scripts).toHaveLength(1);
  expect(target.fbq!.queue).toContainEqual(["set", "autoConfig", false, "123456789"]);
  expect(target.fbq!.queue).toContainEqual(["init", "123456789"]);
});

it("revokes consent and drops a pending signup even when storage writes fail", async () => {
  const ads = await import("./ad-measurement");
  ads.setAdMeasurementAllowed(true); ads.recordNewRegistration(true);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: () => { throw Error("full"); }, removeItem: (key: string) => storage.delete(key) });
  ads.setAdMeasurementAllowed(false); scripts[0]!.onload();
  expect(ads.adMeasurementAllowed()).toBe(false);
  expect(target.fbq!.queue).toContainEqual(["consent", "revoke"]);
  expect(target.fbq!.queue.some((call) => call[0] === "trackSingle")).toBe(false);
  expect(storage.has("nation-new-registration-v1")).toBe(false);
});

it("respects Global Privacy Control and the existing analytics opt-out", async () => {
  const ads = await import("./ad-measurement");
  vi.stubGlobal("navigator", { globalPrivacyControl: true });
  ads.setAdMeasurementAllowed(true); expect(scripts).toHaveLength(0);
  vi.stubGlobal("navigator", {}); storage.set("omb-analytics-opt-out", "1");
  ads.startAdMeasurement(); expect(scripts).toHaveLength(0);
});

it("honors a consent withdrawal in another tab", async () => {
  const ads = await import("./ad-measurement");
  ads.setAdMeasurementAllowed(true);
  storage.set("nation-ad-measurement-v1", "no");
  target.addEventListener.mock.calls[0]![1]({ key: "nation-ad-measurement-v1" });
  scripts[0]!.onload();
  expect(ads.adMeasurementAllowed()).toBe(false);
  expect(target.fbq!.queue.some((call) => call[0] === "trackSingle")).toBe(false);
  expect(target.fbq!.queue).toContainEqual(["consent", "revoke"]);
});

it("ignores preview hosts, sign-in secrets and private routes", async () => {
  const ads = await import("./ad-measurement");
  for (const path of ["/swarm/#login=secret", "/swarm/?email=ada%40example.test", "/swarm/?utm_content=ada%40example.test", "/swarm/admin"]) {
    vi.stubGlobal("location", new URL("https://thenation.city" + path));
    ads.setAdMeasurementAllowed(true);
  }
  vi.stubGlobal("location", new URL("https://preview.vercel.app/swarm/"));
  ads.startAdMeasurement(); expect(scripts).toHaveLength(0);
});

it("does not count stale, future or malformed pending registrations", async () => {
  const ads = await import("./ad-measurement");
  ads.setAdMeasurementAllowed(true); scripts[0]!.onload();
  for (const data of ["bad-json", JSON.stringify({ id: crypto.randomUUID(), at: Date.now() - 700_000 }), JSON.stringify({ id: crypto.randomUUID(), at: Date.now() + 700_000 })]) {
    storage.set("nation-new-registration-v1", data); ads.startAdMeasurement();
  }
  expect(target.fbq!.queue.some((call) => call[2] === "CompleteRegistration")).toBe(false);
});

it("a blocked SDK never throws or consumes an unsent registration", async () => {
  const ads = await import("./ad-measurement");
  ads.setAdMeasurementAllowed(true); ads.recordNewRegistration(true);
  expect(() => scripts[0]!.onerror()).not.toThrow();
  expect(storage.has("nation-new-registration-v1")).toBe(true);
});
