import { afterEach, describe, expect, it, vi } from "vitest";

import { appHostContext, appMaxHeight, appStyleVariables } from "./app-host-context";

const tokens: Record<string, string> = {
  "--color-composer": "#ffffff", "--color-ink": "#0f1a13", "--color-ink-secondary": "#4d5a52", "--color-ink-tertiary": "#4f5c54",
  "--color-inset": "#e7ece8", "--color-app": "#ffffff", "--color-accent": "#1a7a48", "--color-accent-text": "#176b3f",
  "--color-accent-border": "#1f8a52", "--color-danger": "#c02b3a", "--color-success": "#1a7a48", "--color-warning": "#8a5a00",
  "--color-focus": "#1a7a48", "--font-sans": "\"Inter\", system-ui, sans-serif",
};
const root = { nodeType: 1 } as unknown as Element;

afterEach(() => vi.unstubAllGlobals());

describe("the skin as MCP Apps variables", () => {
  it("resolves each variable from the skin's own tokens", () => {
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (name: string) => tokens[name] ?? "" }));
    const variables = appStyleVariables(root);
    expect(variables["--color-background-primary"]).toBe("#ffffff");
    expect(variables["--color-text-primary"]).toBe("#0f1a13");
    expect(variables["--color-text-info"]).toBe("#176b3f");
    expect(variables["--color-border-primary"]).toBe("color-mix(in srgb, #0f1a13 20%, #ffffff)");
    expect(variables["--font-sans"]).toBe("\"Inter\", system-ui, sans-serif");
    expect(variables["--border-radius-xl"]).toBe("24px");
    // nothing left that only this page could resolve
    expect(Object.values(variables).some((value) => value.includes("var("))).toBe(false);
  });

  it("leaves out a variable whose token this page does not define", () => {
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    const variables = appStyleVariables(root);
    expect(variables["--color-text-primary"]).toBeUndefined();
    expect(variables["--font-weight-bold"]).toBe("700");
  });
});

describe("the host context", () => {
  it("is inline only, names the host, and carries the frame's size", () => {
    vi.stubGlobal("window", { innerHeight: 1_000 });
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    expect(appMaxHeight()).toBe(700);
    const context = appHostContext({ width: 612.4, maxHeight: 700 });
    expect(context).toMatchObject({
      displayMode: "inline", availableDisplayModes: ["inline"], containerDimensions: { width: 612, maxHeight: 700 },
      platform: "web", userAgent: expect.stringMatching(/^MausBot\//),
    });
    vi.stubGlobal("window", { innerHeight: 2_000, ogb: {} });
    expect(appMaxHeight()).toBe(720);
    expect(appHostContext({ width: 600, maxHeight: 720 }).platform).toBe("desktop");
  });
});
