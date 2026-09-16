import { describe, expect, it, vi } from "vitest";
import {
  ensureManagedComposioCredentials,
  managedComposioAccess,
  managedComposioChildEnvironment,
  normalizeManagedComposioBrokerUrl,
} from "./managed-composio.mjs";

const TOKEN = "a".repeat(64);

describe("managed Composio desktop registration", () => {
  it("publishes only a complete broker credential", () => {
    expect(managedComposioAccess("https://broker.example/", { composioBrokerToken: TOKEN })).toEqual({
      url: "https://broker.example",
      token: TOKEN,
    });
    expect(managedComposioAccess("https://broker.example", {})).toBeNull();
    expect(managedComposioAccess("", { composioBrokerToken: TOKEN })).toBeNull();
  });

  it("accepts HTTPS and loopback development brokers but rejects insecure remote URLs", async () => {
    expect(normalizeManagedComposioBrokerUrl("https://broker.example/root/")).toBe(
      "https://broker.example/root",
    );
    expect(normalizeManagedComposioBrokerUrl("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(normalizeManagedComposioBrokerUrl("http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(normalizeManagedComposioBrokerUrl("http://[::1]:8787/")).toBe(
      "http://[::1]:8787",
    );
    expect(normalizeManagedComposioBrokerUrl("http://broker.example")).toBe("");
    expect(normalizeManagedComposioBrokerUrl("https://user:secret@broker.example")).toBe("");
    expect(normalizeManagedComposioBrokerUrl("https://broker.example?redirect=evil")).toBe("");

    const fetchImpl = vi.fn();
    const credentials = { composioBrokerToken: TOKEN };
    await ensureManagedComposioCredentials({
      brokerUrl: "http://broker.example",
      credentials,
      fetchImpl,
      saveCredentials: vi.fn(),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(managedComposioAccess("http://broker.example", credentials)).toBeNull();
    expect(
      managedComposioChildEnvironment("http://broker.example", credentials, {
        PATH: "/usr/bin",
        ASTRA_COMPOSIO_BROKER_URL: "http://attacker.example",
        ASTRA_COMPOSIO_BROKER_TOKEN: "attacker-controlled",
      }),
    ).toEqual({ PATH: "/usr/bin" });
    expect(
      managedComposioChildEnvironment("http://[::1]:8787", credentials, { PATH: "/usr/bin" }),
    ).toEqual({
      PATH: "/usr/bin",
      ASTRA_COMPOSIO_BROKER_URL: "http://[::1]:8787",
      ASTRA_COMPOSIO_BROKER_TOKEN: TOKEN,
    });
  });

  it("registers a new installation and persists it", async () => {
    const credentials = {};
    const saveCredentials = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: TOKEN, installationId: "installation-test" }),
    }));

    await ensureManagedComposioCredentials({
      brokerUrl: "https://broker.example",
      credentials,
      fetchImpl,
      saveCredentials,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://broker.example/v1/installations",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    expect(credentials).toEqual({
      composioBrokerToken: TOKEN,
      composioInstallationId: "installation-test",
    });
    expect(saveCredentials).toHaveBeenCalledWith(credentials);
  });

  it("settles a stalled optional registration without storing partial credentials", async () => {
    vi.useFakeTimers();
    try {
      const credentials = {};
      const saveCredentials = vi.fn(async () => {});
      const log = vi.fn();
      const fetchImpl = vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          }),
      );
      const operation = ensureManagedComposioCredentials({
        brokerUrl: "https://broker.example",
        credentials,
        fetchImpl,
        saveCredentials,
        log,
        registrationTimeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(operation).resolves.toBe(credentials);
      expect(credentials).toEqual({});
      expect(saveCredentials).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("registration failed"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a valid installation identity during a transient broker outage", async () => {
    const credentials = {
      composioBrokerToken: TOKEN,
      composioInstallationId: "installation-test",
    };
    const saveCredentials = vi.fn(async () => {});

    await ensureManagedComposioCredentials({
      brokerUrl: "https://broker.example",
      credentials,
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }),
      saveCredentials,
    });

    expect(credentials).toEqual({
      composioBrokerToken: TOKEN,
      composioInstallationId: "installation-test",
    });
    expect(saveCredentials).not.toHaveBeenCalled();
  });
});
