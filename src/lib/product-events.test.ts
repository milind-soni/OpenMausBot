import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/state/store";
import { keySaveFailure, keyTestResult, savedKeyResult } from "./product-events";

const ph = vi.hoisted(() => ({
  captured: [] as Array<{ event: string; props: unknown }>,
  module: () => ({
    default: {
      init: () => {},
      has_opted_out_capturing: () => false,
      opt_in_capturing: () => {},
      opt_out_capturing: () => {},
      register: () => {},
      unregister: () => {},
      capture: (event: string, props?: unknown) => void ph.captured.push({ event, props }),
      identify: () => {},
    },
  }),
}));
vi.mock("posthog-js", () => ph.module());

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});

beforeEach(() => {
  store.clear();
  ph.captured = [];
});

describe("why a key save failed", () => {
  it("calls it rejected only when the provider refused the key", () => {
    expect(keySaveFailure(new ApiError("boat.dev rejected that key", 400, { error: "boat.dev rejected that key", code: "key_rejected" }))).toBe("rejected");
    expect(keySaveFailure(new Error("Error invoking remote method 'credential:set': KeyRejected: That doesn't look like a Boat API key"))).toBe("rejected");
  });

  it("calls every other failure an error", () => {
    for (const cause of [
      new ApiError("bad request", 400, { error: "bad request" }),
      new ApiError("hosted models", 403, { error: "This workspace uses hosted models" }),
      new ApiError("finish deleting first", 409, { error: "busy" }),
      new ApiError("unavailable", 503, {}),
      new ApiError("decider", 400, { code: "decider_rejected" }),
      new TypeError("Failed to fetch"),
      new Error("Error invoking remote method 'credential:set': Error: The embedded bot server is unavailable"),
      new Error("KeyRejected: not over IPC"),
      "key_rejected",
      null,
      undefined,
    ]) expect(keySaveFailure(cause)).toBe("error");
  });
});

describe("what a saved key's check said", () => {
  it("follows the key test when one runs", () => {
    expect(keyTestResult({ ok: true, check: "authentication" } as never)).toBe("ok");
    expect(keyTestResult({ ok: false, reason: "rejected" })).toBe("rejected");
    expect(keyTestResult({ ok: false, reason: "unreachable" })).toBe("unverified");
    expect(keyTestResult({ ok: false, reason: "unexpected", status: 500 } as never)).toBe("unverified");
    expect(keyTestResult(null)).toBe("unverified");
  });

  it("is ok for keys the server checks before saving, and unverified for the rest", () => {
    for (const provider of ["boat", "composio", "elevenlabs", "fish_audio"] as const) expect(savedKeyResult(provider)).toBe("ok");
    for (const provider of ["opencode_go", "openai_image", "custom_endpoint", "xai", "other"] as const) expect(savedKeyResult(provider)).toBe("unverified");
  });
});

describe("what reaches PostHog", () => {
  it("is exactly provider, via and result for a key save, with app_version and surface registered beside it", async () => {
    vi.resetModules();
    vi.doMock("posthog-js", () => ph.module());
    const analytics = await import("./analytics");
    const events = await import("./product-events");
    await analytics.initAnalytics();
    events.keySaved("boat", "computer_panel", "rejected");
    events.keyRemoved("anthropic", "settings");
    events.keySaved("sk-ant-api03-ZZtestSECRET0123456789" as never, "https://evil.example.com" as never, "ok");
    expect(ph.captured.filter(({ event }) => event.startsWith("api_key_"))).toEqual([
      { event: "api_key_saved", props: { provider: "boat", via: "computer_panel", result: "rejected" } },
      { event: "api_key_removed", props: { provider: "anthropic", via: "settings" } },
      { event: "api_key_saved", props: { provider: "other", via: "other", result: "ok" } },
    ]);
  });

  it("names a starting role only from the built-in list, and never a preset", async () => {
    vi.resetModules();
    vi.doMock("posthog-js", () => ph.module());
    const analytics = await import("./analytics");
    const events = await import("./product-events");
    await analytics.initAnalytics();
    events.botCreated("template", "research");
    events.botCreated("template", "a role from a newer build");
    events.botCreated("preset", "My secret preset");
    events.botCreated("blank");
    expect(ph.captured.filter(({ event }) => event === "bot_created").map(({ props }) => props)).toEqual([
      { source: "template", template: "research" },
      { source: "template", template: "other" },
      { source: "preset" },
      { source: "blank" },
    ]);
  });
});
