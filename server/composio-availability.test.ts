import { afterEach, describe, expect, it, vi } from "vitest";

import { connectorAvailability, connectorSetup } from "./composio.ts";
import type { AppConfig } from "./config.ts";

afterEach(() => vi.unstubAllEnvs());

const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...over }) as AppConfig;

describe("connectorAvailability", () => {
  it("is configured when a project key is present", () => {
    expect(connectorAvailability(cfg({ composio: { apiKey: "ak_live" } }), undefined)).toBe("configured");
  });

  it("is unconfigured when there is no key and the store read fine", () => {
    expect(connectorAvailability(cfg(), undefined)).toBe("unconfigured");
    expect(connectorAvailability(cfg({ composio: { apiKey: "" } }), "ok")).toBe("unconfigured");
  });

  it("is unreadable when the desktop shell could not open the credential store", () => {
    expect(connectorAvailability(cfg(), "unavailable")).toBe("unreadable");
  });

  it("prefers a working key over a store that failed earlier in the launch", () => {
    // the key arrived some other way (env, self-hosted config): what the user
    // can actually do matters more than how the shell felt about it
    expect(connectorAvailability(cfg({ composio: { apiKey: "ak_live" } }), "unavailable")).toBe("configured");
  });
});

describe("connectorSetup", () => {
  it("is ready when a connection service is configured", () => {
    expect(connectorSetup(cfg({ composio: { apiKey: "ak_live" } }), false)).toBe("ready");
    expect(connectorSetup(cfg({ composio: { apiKey: "ak_live" } }), true)).toBe("ready");
  });

  it("needs setup on a fresh server that has no managed service to wait for", () => {
    expect(connectorSetup(cfg(), false)).toBe("needs-setup");
    expect(connectorSetup(cfg({ composio: { apiKey: "" } }), false)).toBe("needs-setup");
  });

  it("reports the managed service as unavailable only on a managed host with a broker URL configured", () => {
    expect(connectorSetup(cfg(), true, "https://broker.example.test")).toBe("service-unavailable");
    expect(connectorSetup(cfg(), false, "https://broker.example.test")).toBe("needs-setup");
  });

  it("needs setup on the desktop app when no broker URL is configured, since none ships by default", () => {
    vi.stubEnv("OMB_DESKTOP_PARENT", "1");
    vi.stubEnv("OMB_COMPOSIO_BROKER_URL", "");
    expect(connectorSetup(cfg())).toBe("needs-setup");
    expect(connectorSetup(cfg(), true, undefined)).toBe("needs-setup");
    expect(connectorSetup(cfg(), true, "not a url")).toBe("needs-setup");
  });

  it("needs setup when OMB_COMPOSIO_BROKER=off, even with a broker URL", () => {
    vi.stubEnv("OMB_COMPOSIO_BROKER", "off");
    expect(connectorSetup(cfg(), true, "https://broker.example.test")).toBe("needs-setup");
  });
});
