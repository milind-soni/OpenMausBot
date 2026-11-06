// Provider selection. Default is Composio with zero config; env and config.json's "connectors"
// key can name another provider; secrets are referenced, never stored inline.
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_PROVIDER_ENV,
  OPENCONNECTOR_ADMIN_TOKEN_ENV,
  OPENCONNECTOR_ADMIN_TOKEN_REF_ENV,
  OPENCONNECTOR_URL_ENV,
  connectorProvider,
  loadConnectorSettings,
  resolveTokenRef,
} from "./provider.ts";
import { composioProvider } from "./composio.ts";

const env = (entries: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...entries });

describe("loadConnectorSettings", () => {
  it("defaults to composio when nothing is configured", () => {
    const settings = loadConnectorSettings(env(), null);
    expect(settings.provider).toBe("composio");
    expect(settings.openconnector).toEqual({ url: undefined, adminTokenRef: undefined });
  });

  it("reads the provider and openconnector fields from the stored connectors key", () => {
    const settings = loadConnectorSettings(env(), {
      provider: "openconnector",
      openconnector: { url: "https://connector.example.test", adminTokenRef: "env:MY_TOKEN" },
    });
    expect(settings.provider).toBe("openconnector");
    expect(settings.openconnector.url).toBe("https://connector.example.test");
    expect(settings.openconnector.adminTokenRef).toBe("env:MY_TOKEN");
  });

  it("lets the env override the stored provider and url", () => {
    const settings = loadConnectorSettings(
      env({ [CONNECTOR_PROVIDER_ENV]: "composio", [OPENCONNECTOR_URL_ENV]: "https://env-wins.example.test" }),
      { provider: "openconnector", openconnector: { url: "https://stored.example.test" } },
    );
    expect(settings.provider).toBe("composio");
    expect(settings.openconnector.url).toBe("https://env-wins.example.test");
  });

  it("falls back to composio on an unknown provider name", () => {
    expect(loadConnectorSettings(env({ [CONNECTOR_PROVIDER_ENV]: "nonsense" }), null).provider).toBe("composio");
    expect(loadConnectorSettings(env(), { provider: "nonsense" as never }).provider).toBe("composio");
  });
});

describe("connectorProvider", () => {
  it("serves the composio provider by default", () => {
    expect(connectorProvider(env())).toBe(composioProvider);
  });

  it("returns the same instance while the settings are unchanged", () => {
    const one = connectorProvider(env({ [CONNECTOR_PROVIDER_ENV]: "composio" }));
    const two = connectorProvider(env({ [CONNECTOR_PROVIDER_ENV]: "composio" }));
    expect(one).toBe(two);
  });

  it("names openconnector as a config error until the OpenConnector provider is wired", () => {
    expect(() => connectorProvider(env({
      [CONNECTOR_PROVIDER_ENV]: "openconnector",
      [OPENCONNECTOR_URL_ENV]: "https://connector.example.test",
      [OPENCONNECTOR_ADMIN_TOKEN_ENV]: "0".repeat(64),
    }))).toThrow(/openconnector.*not available/);
  });
});

describe("resolveTokenRef", () => {
  it("reads env: references from the environment", () => {
    expect(resolveTokenRef("env:MY_TOKEN", env({ MY_TOKEN: " secret \n" }))).toBe("secret");
    expect(resolveTokenRef("env:MISSING", env({}))).toBeUndefined();
  });

  it("reads file: references from disk", () => {
    const dir = new URL(".", import.meta.url).pathname;
    expect(resolveTokenRef(`file:${dir}provider.ts`)).toContain("loadConnectorSettings");
  });

  it("treats a bare name as an env variable and blank as absent", () => {
    expect(resolveTokenRef("MY_TOKEN", env({ MY_TOKEN: "tok" }))).toBe("tok");
    expect(resolveTokenRef("  ", env({}))).toBeUndefined();
    expect(resolveTokenRef(undefined, env({}))).toBeUndefined();
  });

  it("never requires the token to live in the settings file itself", () => {
    const settings = loadConnectorSettings(
      env({ [OPENCONNECTOR_ADMIN_TOKEN_REF_ENV]: "env:OMB_OPENCONNECTOR_ADMIN_TOKEN" }),
      null,
    );
    expect(JSON.stringify(settings)).not.toContain("OMB_OPENCONNECTOR_ADMIN_TOKEN=");
    expect(settings.openconnector.adminTokenRef).toBe("env:OMB_OPENCONNECTOR_ADMIN_TOKEN");
  });
});
