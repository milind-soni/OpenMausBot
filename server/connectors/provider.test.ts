// Provider selection. Default is Composio with zero config; env and config.json's "connectors"
// key can name another provider; secrets are referenced, never stored inline.
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.ts";
import {
  CONNECTOR_PROVIDER_ENV,
  OPENCONNECTOR_ADMIN_TOKEN_ENV,
  OPENCONNECTOR_ADMIN_TOKEN_REF_ENV,
  OPENCONNECTOR_URL_ENV,
  connectorProvider,
  loadConnectorSettings,
  assertOpenConnectorSettings,
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
    const settings = loadConnectorSettings(env(), { provider: "openconnector" });
    expect(settings.provider).toBe("openconnector");
    expect(() => assertOpenConnectorSettings(settings)).toThrow(/no URL/);
    const tokenOnly = loadConnectorSettings(
      env({ [OPENCONNECTOR_URL_ENV]: "https://connector.example.test" }),
      { provider: "openconnector" },
    );
    expect(tokenOnly.provider).toBe("openconnector");
    expect(() => assertOpenConnectorSettings(tokenOnly)).toThrow(/admin token/);
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

  it("reports incomplete or invalid OpenConnector setup without failing status construction", async () => {
    const incomplete = connectorProvider(env({ [CONNECTOR_PROVIDER_ENV]: "openconnector" }));
    expect(incomplete.isConfigured({} as never)).toBe(false);
    expect(incomplete.mode({} as never)).toBe("unavailable");
    await expect(incomplete.status({} as never, ["github"])).resolves.toEqual({
      github: { connected: false, pending: false, status: "setup-needed", accounts: [] },
    });
    const invalid = connectorProvider(env({
      [CONNECTOR_PROVIDER_ENV]: "openconnector",
      [OPENCONNECTOR_URL_ENV]: "http://example.test",
      [OPENCONNECTOR_ADMIN_TOKEN_ENV]: "0".repeat(64),
    }));
    expect(invalid.isConfigured({} as never)).toBe(false);
    await expect(invalid.tools({} as never)).resolves.toEqual({});
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

  it("falls back to unavailable setup when an OpenConnector token file cannot be read", () => {
    const tokenPath = join(tmpdir(), `omb-openconnector-token-${process.pid}-${Date.now()}`);
    const cfg: AppConfig = { composio: { apiKey: "ak_test", userId: "user", sessionId: "session" } };
    const provider = connectorProvider({
      OMB_CONNECTOR_PROVIDER: "openconnector",
      OMB_OPENCONNECTOR_URL: "https://connector.example.test",
      OMB_OPENCONNECTOR_ADMIN_TOKEN_REF: `file:${tokenPath}`,
    });
    expect(provider.mode(cfg)).toBe("unavailable");
    expect(provider.isConfigured(cfg)).toBe(false);
    const stillUnavailable = connectorProvider({
      OMB_CONNECTOR_PROVIDER: "openconnector",
      OMB_OPENCONNECTOR_URL: "https://connector.example.test",
      OMB_OPENCONNECTOR_ADMIN_TOKEN_REF: `file:${tokenPath}`,
    });
    expect(stillUnavailable.mode(cfg)).toBe("unavailable");
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

describe("openConnectorTokenStatus", () => {
  it("reports the env token as configured with its last four", async () => {
    const { openConnectorTokenStatus } = await import("./provider.ts");
    const status = openConnectorTokenStatus({}, env({ [OPENCONNECTOR_ADMIN_TOKEN_ENV]: "secret-tok-9876" }));
    expect(status).toEqual({ configured: true, last4: "9876" });
  });

  it("reads a file reference and reports unconfigured when the file is gone", async () => {
    const { openConnectorTokenStatus } = await import("./provider.ts");
    const dir = mkdtempSync(join(tmpdir(), "omb-oc-token-"));
    try {
      const file = join(dir, "admin-token");
      writeFileSync(file, "file-token-abcd", { mode: 0o600 });
      expect(openConnectorTokenStatus({ adminTokenRef: `file:${file}` }, env())).toEqual({ configured: true, last4: "abcd" });
      rmSync(file);
      expect(openConnectorTokenStatus({ adminTokenRef: `file:${file}` }, env())).toEqual({ configured: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("resolves an env: reference, and hides the last four of a short token", async () => {
    const { openConnectorTokenStatus } = await import("./provider.ts");
    expect(openConnectorTokenStatus({ adminTokenRef: "env:MY_RUNTIME_TOKEN" }, env({ MY_RUNTIME_TOKEN: "ref-token-4321" })))
      .toEqual({ configured: true, last4: "4321" });
    expect(openConnectorTokenStatus({ adminTokenRef: "env:UNSET" }, env())).toEqual({ configured: false });
    expect(openConnectorTokenStatus({}, env({ [OPENCONNECTOR_ADMIN_TOKEN_ENV]: "short" }))).toEqual({ configured: true });
  });

  it("reports the referenced token the provider uses, ahead of the inline env fallback", async () => {
    const { openConnectorTokenStatus } = await import("./provider.ts");
    const dir = mkdtempSync(join(tmpdir(), "omb-oc-token-order-"));
    const file = join(dir, "admin-token");
    try {
      writeFileSync(file, "file-token-abcd", { mode: 0o600 });
      const withFallback = env({ [OPENCONNECTOR_ADMIN_TOKEN_ENV]: "env-token-9876" });
      expect(openConnectorTokenStatus({ adminTokenRef: `file:${file}` }, withFallback))
        .toEqual({ configured: true, last4: "abcd" });
      if (process.platform !== "win32") {
        chmodSync(file, 0o644);
        expect(openConnectorTokenStatus({ adminTokenRef: `file:${file}` }, withFallback)).toEqual({ configured: false });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
