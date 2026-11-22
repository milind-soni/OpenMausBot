import { beforeEach, describe, expect, it, vi } from "vitest";

import { connectAiStep } from "./connect-ai-events";
import { loadWaitingFor } from "./app-load";
import { signInGateShown } from "./sign-in-gate";

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

const HOSTILE = "Claude isn't signed in for ada@example.com with sk-ant-api03-SECRET0123456789";
const sent = (event: string) => ph.captured.filter((entry) => entry.event === event).map((entry) => entry.props);

beforeEach(async () => {
  store.clear();
  ph.captured = [];
  const { initAnalytics } = await import("./analytics");
  await initAnalytics();
});

describe("Connect an AI steps", () => {
  it("names the engine by its kind and the failure by a word from its list, never the provider's text", () => {
    connectAiStep("test_failed", "meet", { driverKind: "claudeAgent", reason: "signed_out", seconds: 12.4 });
    connectAiStep("test_failed", "chat", { driverKind: "Ada's own engine", reason: HOSTILE });
    connectAiStep("chosen", "cloud_welcome", { driverKind: "codex", reason: HOSTILE });
    connectAiStep("opened", "meet", { aiReady: false });
    expect(sent("connect_ai")).toEqual([
      { step: "test_failed", place: "meet", engine: "claude", reason: "signed_out", seconds: 12 },
      { step: "test_failed", place: "chat", engine: "other", reason: "other" },
      { step: "chosen", place: "cloud_welcome", engine: "codex" },
      { step: "opened", place: "meet", ai_ready: false },
    ]);
    expect(JSON.stringify(ph.captured)).not.toMatch(/ada@|sk-ant|Ada's/);
  });

  it("sends a step or a place it does not know as other", () => {
    connectAiStep("sneaky" as never, "settings" as never);
    expect(sent("connect_ai")).toEqual([{ step: "other", place: "other" }]);
  });
});

describe("the app's load", () => {
  it("says what it still waits for", () => {
    expect(loadWaitingFor({ connected: false, config: null })).toBe("server");
    expect(loadWaitingFor({ connected: true, config: null })).toBe("data");
    expect(loadWaitingFor({ connected: true, hydrated: true, config: null })).toBe("settings");
    expect(loadWaitingFor({ connected: true, hydrated: true, config: {} })).toBeNull();
  });
});

describe("the sign-in gate", () => {
  it("is counted on the desktop app's own page only", () => {
    signInGateShown("signed_out");
    expect(sent("sign_in_gate")).toEqual([]);
    vi.stubGlobal("window", { ...globalThis.window, ogb: { environments: {} } });
    try {
      signInGateShown("service_trust");
      signInGateShown("/pair?code=SECRET" as never);
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) });
    }
    expect(sent("sign_in_gate")).toEqual([{ reason: "service_trust" }, { reason: "other" }]);
  });
});
