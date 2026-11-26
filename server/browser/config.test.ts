import { describe, expect, it } from "vitest";

import { browserEngineConfigSchema, browserPaneWanted, cloudDisplayWanted } from "./config.ts";

describe("browser engine proxy configuration", () => {
  it("accepts an unauthenticated SOCKS5 endpoint", () => {
    expect(browserEngineConfigSchema.parse({ egress: { proxy: "socks5://127.0.0.1:1080" } }).egress?.proxy)
      .toBe("socks5://127.0.0.1:1080");
  });

  it("rejects credentials, other protocols, and invalid ports", () => {
    for (const proxy of ["http://127.0.0.1:8080", "socks5://user:pass@proxy.example:1080", "socks5://proxy.example:0", "socks5://proxy.example:65536", "socks5://..example:1080", "socks5://[:::]:1080"]) {
      expect(browserEngineConfigSchema.safeParse({ egress: { proxy } }).success, proxy).toBe(false);
    }
  });
});

describe("the desktop pane setting", () => {
  it("is off unless set, and needs the Chrome engine", () => {
    expect(browserPaneWanted({})).toBe(false);
    expect(browserPaneWanted({ browserEngine: { surface: "pane" } })).toBe(false);
    expect(browserPaneWanted({ browserEngine: { engine: "chrome" } })).toBe(false);
    expect(browserPaneWanted({ browserEngine: { engine: "chrome", surface: "stream" } })).toBe(false);
    expect(browserPaneWanted({ browserEngine: { engine: "chrome", surface: "pane" } })).toBe(true);
    expect(browserEngineConfigSchema.safeParse({ surface: "window" }).success).toBe(false);
    expect(browserEngineConfigSchema.parse({ paneIdentity: "cleaned" }).paneIdentity).toBe("cleaned");
    expect(browserEngineConfigSchema.parse({}).paneIdentity).toBeUndefined();
    expect(browserEngineConfigSchema.safeParse({ paneIdentity: "firefox" }).success).toBe(false);
  });
});

describe("cloud display setting", () => {
  const on = { browserEngine: { engine: "chrome" as const, cloudDisplay: true } };

  it("is off unless asked for", () => {
    expect(browserEngineConfigSchema.parse({}).cloudDisplay).toBeUndefined();
    expect(cloudDisplayWanted({}, "container", "linux")).toBe(false);
    expect(cloudDisplayWanted({ browserEngine: { engine: "chrome" } }, "container", "linux")).toBe(false);
  });

  it("needs the new engine, a server and Linux", () => {
    expect(cloudDisplayWanted(on, "container", "linux")).toBe(true);
    expect(cloudDisplayWanted(on, "server", "linux")).toBe(true);
    expect(cloudDisplayWanted({ browserEngine: { cloudDisplay: true } }, "container", "linux")).toBe(false);
    expect(cloudDisplayWanted(on, "desktop", "linux")).toBe(false);
    expect(cloudDisplayWanted(on, "server", "darwin")).toBe(false);
  });

  it("accepts only a boolean", () => {
    expect(browserEngineConfigSchema.safeParse({ cloudDisplay: "yes" }).success).toBe(false);
  });
});
