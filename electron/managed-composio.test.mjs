import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MANAGED_COMPOSIO_BROKER_URL,
  ensureManagedComposioCredentials,
  managedComposioAccess,
  managedComposioBrokerUrl,
  managedComposioChildEnvironment,
  normalizeManagedComposioBrokerUrl,
  ownComposioKey,
  registerManagedComposio,
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

  it("uses the default service only in a shipped build (the packaged app, a Cloud home's image); an explicit URL wins", () => {
    expect(DEFAULT_MANAGED_COMPOSIO_BROKER_URL).toMatch(/^https:\/\//);
    expect(managedComposioBrokerUrl(undefined, true)).toBe(DEFAULT_MANAGED_COMPOSIO_BROKER_URL);
    expect(managedComposioBrokerUrl("  ", true)).toBe(DEFAULT_MANAGED_COMPOSIO_BROKER_URL);
    expect(managedComposioBrokerUrl(undefined, false)).toBe("");
    expect(managedComposioBrokerUrl(" http://127.0.0.1:8787/ ", false)).toBe("http://127.0.0.1:8787");
    expect(managedComposioBrokerUrl("http://broker.example", true)).toBe("");
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
        OMB_COMPOSIO_BROKER_URL: "http://attacker.example",
        OMB_COMPOSIO_BROKER_TOKEN: "attacker-controlled",
      }),
    ).toEqual({ PATH: "/usr/bin" });
    expect(
      managedComposioChildEnvironment("http://[::1]:8787", credentials, { PATH: "/usr/bin" }),
    ).toEqual({
      PATH: "/usr/bin",
      OMB_COMPOSIO_BROKER_URL: "http://[::1]:8787",
      OMB_COMPOSIO_BROKER_TOKEN: TOKEN,
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

afterEach(() => vi.unstubAllEnvs());

describe("keeping the desktop app off the managed service", () => {
  const launch = async (credentials) => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await registerManagedComposio({
      brokerUrl: "https://broker.example",
      fetchImpl,
      updateCredentials: async (derive) => derive(credentials),
    });
    return fetchImpl;
  };

  it("with no key and no switch, checks in as before", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "");
    const fetchImpl = await launch({ composioBrokerToken: TOKEN });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://broker.example/v1/me");
  });

  it("sends nothing while the person's own project key is saved or set in the environment", async () => {
    expect(await launch({ composioApiKey: "ak_owner", composioBrokerToken: TOKEN })).not.toHaveBeenCalled();
    expect(await launch({ composioApiKey: "ak_owner" })).not.toHaveBeenCalled();
    vi.stubEnv("COMPOSIO_API_KEY", "ak_from_env");
    expect(await launch({ composioBrokerToken: TOKEN })).not.toHaveBeenCalled();
  });

  it("treats a blank key as no key", () => {
    vi.stubEnv("COMPOSIO_API_KEY", " ");
    expect(ownComposioKey({ composioApiKey: "  " })).toBe(false);
    expect(ownComposioKey({ composioApiKey: "ak_owner" })).toBe(true);
  });

  it("OMB_COMPOSIO_BROKER=off stops registration, check-in and the token handed to the server, with or without a key", async () => {
    vi.stubEnv("OMB_COMPOSIO_BROKER", " Off ");
    vi.stubEnv("COMPOSIO_API_KEY", "");
    expect(managedComposioBrokerUrl(undefined, true)).toBe("");
    expect(managedComposioBrokerUrl("https://broker.example", true)).toBe("");
    expect(managedComposioAccess("https://broker.example", { composioBrokerToken: TOKEN })).toBeNull();
    expect(managedComposioChildEnvironment("https://broker.example", { composioBrokerToken: TOKEN }, {
      PATH: "/usr/bin", OMB_COMPOSIO_BROKER: "off", OMB_COMPOSIO_BROKER_URL: "https://broker.example", OMB_COMPOSIO_BROKER_TOKEN: TOKEN,
    })).toEqual({ PATH: "/usr/bin", OMB_COMPOSIO_BROKER: "off" });

    expect(await launch({ composioBrokerToken: TOKEN })).not.toHaveBeenCalled();
    expect(await launch({})).not.toHaveBeenCalled();
    expect(await launch({ composioApiKey: "ak_owner" })).not.toHaveBeenCalled();
    await expect(registerManagedComposio({ brokerUrl: managedComposioBrokerUrl(undefined, true), updateCredentials: vi.fn() })).resolves.toBeUndefined();
  });

  it("any other value of the switch leaves the service on", () => {
    vi.stubEnv("OMB_COMPOSIO_BROKER", "on");
    expect(managedComposioBrokerUrl(undefined, true)).toBe(DEFAULT_MANAGED_COMPOSIO_BROKER_URL);
  });
});
