import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailGateDone, setEmailGateDone } from "./analytics";

vi.mock("posthog-js", () => ({
  default: {
    init: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
  },
}));

describe("analytics emailGate", () => {
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
  };

  beforeEach(() => {
    store.clear();
    // @ts-expect-error test mock
    globalThis.localStorage = mockStorage;
  });

  afterEach(() => {
    // @ts-expect-error test mock
    delete globalThis.localStorage;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns false initially when gate is not set", () => {
    expect(emailGateDone()).toBe(false);
  });

  it("returns true after setEmailGateDone('submitted')", () => {
    setEmailGateDone("submitted");
    expect(emailGateDone()).toBe(true);
    expect(mockStorage.getItem("gbs-email-gate")).toBe("submitted");
  });

  it("returns true after setEmailGateDone('skipped')", () => {
    setEmailGateDone("skipped");
    expect(emailGateDone()).toBe(true);
    expect(mockStorage.getItem("gbs-email-gate")).toBe("skipped");
  });

  it("gracefully returns false when localStorage is undefined", () => {
    // @ts-expect-error test mock
    delete globalThis.localStorage;
    expect(emailGateDone()).toBe(false);
  });

  describe("usage analytics consent", () => {
    beforeEach(() => {
      vi.resetModules();
      vi.clearAllMocks();
      vi.stubEnv("VITE_POSTHOG_TOKEN", "test-project-token");
      vi.stubGlobal("navigator", { userAgent: "Test Browser" });
    });

    it("does not initialize or capture without explicit consent", async () => {
      const analytics = await import("./analytics");
      const sdk = (await import("posthog-js")).default;
      analytics.initAnalytics();
      analytics.track("message_sent");
      expect(analytics.usageAnalyticsEnabled()).toBe(false);
      expect(sdk.init).not.toHaveBeenCalled();
      expect(sdk.capture).not.toHaveBeenCalled();
    });

    it("initializes only after opt-in and stops capturing immediately on opt-out", async () => {
      const analytics = await import("./analytics");
      const sdk = (await import("posthog-js")).default;
      expect(analytics.setUsageAnalyticsEnabled(true)).toBe(true);
      await vi.waitFor(() => expect(sdk.init).toHaveBeenCalledOnce());
      expect(sdk.init).toHaveBeenCalledWith("test-project-token", expect.objectContaining({ opt_out_capturing_by_default: true }));
      expect(sdk.opt_in_capturing).toHaveBeenCalledOnce();
      analytics.track("message_sent");
      expect(sdk.capture).toHaveBeenCalledWith("message_sent", undefined);

      expect(analytics.setUsageAnalyticsEnabled(false)).toBe(true);
      expect(sdk.opt_out_capturing).toHaveBeenCalledOnce();
      vi.mocked(sdk.capture).mockClear();
      analytics.track("message_sent");
      expect(sdk.capture).not.toHaveBeenCalled();

      expect(analytics.setUsageAnalyticsEnabled(true)).toBe(true);
      expect(sdk.opt_in_capturing).toHaveBeenCalledTimes(2);
      expect(sdk.init).toHaveBeenCalledOnce();
    });

    it("keeps analytics off when no project token is configured", async () => {
      vi.stubEnv("VITE_POSTHOG_TOKEN", "");
      const analytics = await import("./analytics");
      const sdk = (await import("posthog-js")).default;
      expect(analytics.setUsageAnalyticsEnabled(true)).toBe(false);
      expect(analytics.usageAnalyticsEnabled()).toBe(false);
      expect(sdk.init).not.toHaveBeenCalled();
    });
  });
});
