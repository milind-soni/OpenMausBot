// Provider selection. Default is Composio with zero config; env and config.json's "connectors"
// key can name another provider; secrets are referenced, never stored inline.
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("keeps an explicit provider when stored OpenConnector settings are malformed", () => {
    const settings = loadConnectorSettings(
      env({
        [OPENCONNECTOR_URL_ENV]: "https://env-wins.example.test",
        [OPENCONNECTOR_ADMIN_TOKEN_ENV]: "0".repeat(64),
      }),
      { provider: "openconnector", openconnector: { url: 123 } as never },
    );
    expect(settings.provider).toBe("openconnector");
    expect(settings.openconnector.url).toBe("https://env-wins.example.test");
  });

  it("does not silently select Composio when OpenConnector is explicit but incomplete", () => {
    expect(() => loadConnectorSettings(env(), { provider: "openconnector" })).toThrow(/no URL/);
    expect(() => loadConnectorSettings(
      env({ [OPENCONNECTOR_URL_ENV]: "https://connector.example.test" }),
      { provider: "openconnector" },
    )).toThrow(/admin token/);
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

  it("selects the openconnector provider when configured with a url and a resolvable token", () => {
    const selected = connectorProvider(env({
      [CONNECTOR_PROVIDER_ENV]: "openconnector",
      [OPENCONNECTOR_URL_ENV]: "https://connector.example.test",
      [OPENCONNECTOR_ADMIN_TOKEN_ENV]: "0".repeat(64),
    }));
    expect(selected.id).toBe("openconnector");
    expect(selected.isConfigured({} as never)).toBe(true);
    expect(selected).not.toBe(composioProvider);
  });

  it("selects a degraded OpenConnector provider instead of throwing when settings are incomplete", () => {
    const selected = connectorProvider(env({
      [CONNECTOR_PROVIDER_ENV]: "openconnector",
      [OPENCONNECTOR_URL_ENV]: "https://connector.example.test",
    }));
    expect(selected.id).toBe("openconnector");
    expect(selected.isConfigured({} as never)).toBe(false);
  });

  it("does not reuse a provider bound to a different direct admin token", () => {
    const settings = (token: string) => env({
      [CONNECTOR_PROVIDER_ENV]: "openconnector",
      [OPENCONNECTOR_URL_ENV]: "https://connector.example.test",
      [OPENCONNECTOR_ADMIN_TOKEN_ENV]: token,
    });
    const one = connectorProvider(settings("1".repeat(64)));
    expect(connectorProvider(settings("1".repeat(64)))).toBe(one);
    const two = connectorProvider(settings("2".repeat(64)));
    expect(two).not.toBe(one);
  });
});

describe("resolveTokenRef", () => {
  it("reads env: references from the environment", () => {
    expect(resolveTokenRef("env:MY_TOKEN", env({ MY_TOKEN: " secret \n" }))).toBe("secret");
    expect(resolveTokenRef("env:MISSING", env({}))).toBeUndefined();
  });

  it("reads file: references from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-token-ref-"));
    const path = join(dir, "provider.ts");
    writeFileSync(path, readFileSync(join(dirname(fileURLToPath(import.meta.url)), "provider.ts")));
    chmodSync(path, 0o600);
    try {
      expect(resolveTokenRef(`file:${path}`)).toContain("loadConnectorSettings");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a POSIX token file readable by group or other", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "omb-token-ref-"));
    const path = join(dir, "admin-token");
    writeFileSync(path, "token\n", { mode: 0o644 });
    try {
      expect(() => resolveTokenRef(`file:${path}`)).toThrow(/rotate the token/);
    } finally {
      chmodSync(path, 0o600);
      rmSync(dir, { recursive: true, force: true });
    }
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
