import { describe, expect, it, vi } from "vitest";

import { ControlPlaneError } from "./control-plane-client.mjs";
import {
  COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD,
  COMPANION_ACCOUNT_EMAIL_FIELD,
  COMPANION_ACCOUNT_TOKEN_FIELD,
  COMPANION_ACCOUNT_USER_ID_FIELD,
  COMPANION_CLIENT_INSTANCE_FIELD,
  COMPANION_INSTALLATION_CREDENTIAL_FIELD,
  COMPANION_INSTALLATION_ID_FIELD,
  createCompanionAccountService,
  resolveCompanionControlPlaneURL,
} from "./companion-account-service.mjs";
import {
  MANAGED_COMPANION_ENDPOINT_FIELD,
  MANAGED_COMPANION_ORIGIN_VERSION,
  MANAGED_COMPANION_ORIGIN_VERSION_FIELD,
  MANAGED_COMPANION_TOKEN_FIELD,
} from "./managed-companion-tunnel.mjs";

const UUID = "11111111-1111-4111-8111-111111111111";
const INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const DUPLICATE_INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_TOKEN = `signed.${"a".repeat(80)}`;
const INSTALLATION_CREDENTIAL = `omb_install_${"b".repeat(22)}.${"c".repeat(43)}`;
const CONNECTOR_TOKEN = `eyJ${"d".repeat(100)}`;
const ENDPOINT = "https://c-opaque.openmausbot.com";

function credentialStore(initial = {}) {
  let document = structuredClone(initial);
  const writes = [];
  return {
    read: () => structuredClone(document),
    update: vi.fn(async (derive) => {
      document = structuredClone(await derive(structuredClone(document)));
      writes.push(structuredClone(document));
      return structuredClone(document);
    }),
    writes,
  };
}

function readyClient(overrides = {}) {
  return {
    health: vi.fn(async () => true),
    requestOTP: vi.fn(async (email) => ({ email })),
    verifyOTP: vi.fn(async (email) => ({
      accountToken: ACCOUNT_TOKEN,
      user: { id: "user-1", email },
    })),
    ensureInstallation: vi.fn(async () => ({
      installation: {
        id: INSTALLATION_ID,
        clientInstanceId: UUID,
        name: "Test Mac",
        platform: "darwin",
      },
      credential: INSTALLATION_CREDENTIAL,
      credentialExpiresAt: Date.now() + 10_000,
    })),
    ensureEndpoint: vi.fn(async () => ({
      endpoint: { url: ENDPOINT },
      connectorToken: CONNECTOR_TOKEN,
    })),
    listInstallations: vi.fn(async () => []),
    deleteEndpoint: vi.fn(async () => {}),
    revokeInstallation: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    ...overrides,
  };
}

function serviceFixture({ initial, client = readyClient(), ...overrides } = {}) {
  const store = credentialStore(initial);
  const service = createCompanionAccountService({
    client,
    readCredentials: store.read,
    updateCredentials: store.update,
    identity: { name: "Test Mac", platform: "darwin", appVersion: "1.2.3" },
    newClientInstanceId: () => UUID,
    activatePersistedEndpoint: vi.fn(async () => ({ status: "ready", ready: true })),
    stopManagedEndpoint: vi.fn(async () => {}),
    managedConnectionState: () => ({ status: "ready", ready: true }),
    companionIsOn: () => true,
    ...overrides,
  });
  return { client, service, store };
}

function signedCredentials(overrides = {}) {
  return {
    [COMPANION_CLIENT_INSTANCE_FIELD]: UUID,
    [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
    [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-1",
    [COMPANION_ACCOUNT_EMAIL_FIELD]: "ada@example.com",
    [COMPANION_INSTALLATION_ID_FIELD]: INSTALLATION_ID,
    [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: INSTALLATION_CREDENTIAL,
    [MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
    [MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
    [MANAGED_COMPANION_ORIGIN_VERSION_FIELD]: MANAGED_COMPANION_ORIGIN_VERSION,
    ...overrides,
  };
}

describe("Companion account service", () => {
  it("uses the packaged hosted default and only explicit safe development origins", () => {
    expect(resolveCompanionControlPlaneURL({ isPackaged: true, environment: {} })).toBe(
      "https://accounts.openmausbot.com",
    );
    expect(resolveCompanionControlPlaneURL({
      isPackaged: false,
      environment: { OMB_CONTROL_PLANE_URL: "http://127.0.0.1:8787/" },
    })).toBe("http://127.0.0.1:8787");
    expect(resolveCompanionControlPlaneURL({
      isPackaged: true,
      environment: { OMB_CONTROL_PLANE_URL: "http://accounts.openmausbot.com" },
    })).toBe("");
    expect(resolveCompanionControlPlaneURL({
      isPackaged: true,
      environment: { OMB_CONTROL_PLANE_URL: new String("https://accounts.openmausbot.com") },
    })).toBe("");
    expect(resolveCompanionControlPlaneURL({ isPackaged: false, environment: {} })).toBe("");
  });

  it("does not coerce boxed credential fields into an account", async () => {
    const initial = signedCredentials({
      [COMPANION_ACCOUNT_EMAIL_FIELD]: new String("ada@example.com"),
    });
    const { service } = serviceFixture({ initial });

    await expect(service.state()).resolves.toEqual({
      available: true,
      status: "signed-out",
    });
  });

  it("hides account onboarding until the configured control plane is healthy", async () => {
    const client = readyClient({
      health: vi.fn(async () => {
        throw new ControlPlaneError("request_failed", 404);
      }),
    });
    const { service } = serviceFixture({ client });

    await expect(service.restore()).resolves.toMatchObject({
      available: false,
      status: "signed-out",
    });
    await expect(service.requestCode("ada@example.com")).rejects.toThrow(
      "Secure access is not available right now",
    );
    expect(client.requestOTP).not.toHaveBeenCalled();
  });

  it("keeps an existing account recoverable while the control plane is unhealthy", async () => {
    const client = readyClient({
      health: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
    });
    const { service, store } = serviceFixture({ initial: signedCredentials(), client });

    await expect(service.restore()).resolves.toEqual({
      available: true,
      status: "error",
      email: "ada@example.com",
      endpoint: ENDPOINT,
      message: "Secure access is not available right now. Local pairing still works.",
    });
    expect(store.writes).toHaveLength(0);
  });

  it("discovers a control plane that becomes healthy without restarting the app", async () => {
    const health = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("request_failed", 404))
      .mockResolvedValueOnce(true);
    const { service } = serviceFixture({
      client: readyClient({ health }),
      healthCacheMs: 0,
    });

    await expect(service.state()).resolves.toMatchObject({ available: false });
    await expect(service.state()).resolves.toEqual({ available: true, status: "signed-out" });
  });

  it("shows a specific rate-limit message instead of the generic secure-access error", async () => {
    const requestId = "44444444-4444-4444-8444-444444444444";
    const client = readyClient({
      requestOTP: vi.fn(async () => {
        throw new ControlPlaneError("rate_limited", 429, requestId);
      }),
    });
    const { service } = serviceFixture({ client });

    const request = service.requestCode("ada@example.com");
    await expect(request).rejects.toThrow("Too many attempts were made");
    await expect(request).rejects.toThrow(`Reference: ${requestId}`);
    await expect(request).rejects.not.toThrow("Secure access could not be updated");
  });

  it("does not classify local settled-state failures as request failures", async () => {
    const client = readyClient();
    const service = createCompanionAccountService({
      client,
      readCredentials: () => {
        throw new Error("credential store unavailable");
      },
    });

    await expect(service.requestCode("ada@example.com")).rejects.toThrow(
      "credential store unavailable",
    );
    expect(client.requestOTP).toHaveBeenCalledOnce();
  });

  it("persists one stable identity and the complete provision atomically", async () => {
    const activatePersistedEndpoint = vi.fn(async () => ({ status: "ready", ready: true }));
    const { client, service, store } = serviceFixture({ activatePersistedEndpoint });

    await service.requestCode(" Ada@Example.com ");
    const state = await service.verifyCode("Ada@example.com", "12345678");

    expect(state).toEqual({
      available: true,
      status: "ready",
      email: "ada@example.com",
      endpoint: ENDPOINT,
    });
    expect(client.ensureInstallation).toHaveBeenCalledWith({
      accountToken: ACCOUNT_TOKEN,
      currentCredential: "",
      clientInstanceId: UUID,
      name: "Test Mac",
      platform: "darwin",
      appVersion: "1.2.3",
    });
    const persisted = store.read();
    expect(persisted).toMatchObject({
      [COMPANION_CLIENT_INSTANCE_FIELD]: UUID,
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-1",
      [COMPANION_ACCOUNT_EMAIL_FIELD]: "ada@example.com",
      [COMPANION_INSTALLATION_ID_FIELD]: INSTALLATION_ID,
      [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: INSTALLATION_CREDENTIAL,
      [MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
      [MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
      [MANAGED_COMPANION_ORIGIN_VERSION_FIELD]: MANAGED_COMPANION_ORIGIN_VERSION,
    });
    // First write creates the identity; the next single document contains
    // account, installation, endpoint, and connector material together.
    expect(store.writes).toHaveLength(2);
    expect(store.writes[1]).toMatchObject(persisted);
    expect(activatePersistedEndpoint).toHaveBeenCalledOnce();

    await service.restore();
    expect(store.writes).toHaveLength(2);
  });

  it("never exposes any bearer, connector token, installation ID, or credential", async () => {
    const { service } = serviceFixture({ initial: signedCredentials() });
    const state = await service.state();
    const publicJSON = JSON.stringify(state);

    for (const secret of [ACCOUNT_TOKEN, CONNECTOR_TOKEN, INSTALLATION_ID, INSTALLATION_CREDENTIAL]) {
      expect(publicJSON).not.toContain(secret);
    }
    expect(Object.keys(state).sort()).toEqual([
      "available",
      "email",
      "endpoint",
      "status",
    ]);
  });

  it("keeps an invalid code on the signed-out path with a friendly message", async () => {
    const client = readyClient({
      verifyOTP: vi.fn(async () => {
        throw new ControlPlaneError("invalid_otp", 400);
      }),
    });
    const { service } = serviceFixture({ client });

    await expect(service.verifyCode("ada@example.com", "00000000")).rejects.toThrow(
      "That code is not valid",
    );
    expect(await service.state()).toMatchObject({
      available: true,
      status: "signed-out",
      email: "ada@example.com",
    });
    expect(JSON.stringify(await service.state())).not.toContain("invalid_otp");
  });

  it("handles an expired account session without deleting recovery credentials", async () => {
    const client = readyClient({
      ensureInstallation: vi.fn(async () => {
        throw new ControlPlaneError("unauthorized", 401);
      }),
    });
    const incomplete = signedCredentials();
    delete incomplete[MANAGED_COMPANION_ENDPOINT_FIELD];
    delete incomplete[MANAGED_COMPANION_TOKEN_FIELD];
    const { service, store } = serviceFixture({ initial: incomplete, client });

    const state = await service.retry();

    expect(state).toMatchObject({
      status: "signed-out",
      email: "ada@example.com",
      message: expect.stringContaining("sign-in expired"),
    });
    expect(store.read()[COMPANION_ACCOUNT_TOKEN_FIELD]).toBe(ACCOUNT_TOKEN);
    expect(store.read()[COMPANION_INSTALLATION_CREDENTIAL_FIELD]).toBe(INSTALLATION_CREDENTIAL);
  });

  it("recovers from a network provisioning failure on retry", async () => {
    const ensureEndpoint = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("network_unavailable"))
      .mockResolvedValueOnce({ endpoint: { url: ENDPOINT }, connectorToken: CONNECTOR_TOKEN });
    const client = readyClient({ ensureEndpoint });
    const incomplete = signedCredentials();
    delete incomplete[MANAGED_COMPANION_ENDPOINT_FIELD];
    delete incomplete[MANAGED_COMPANION_TOKEN_FIELD];
    const { service } = serviceFixture({ initial: incomplete, client });

    await expect(service.retry()).resolves.toMatchObject({
      status: "error",
      message: expect.stringContaining("Check your internet"),
    });
    await expect(service.retry()).resolves.toMatchObject({
      status: "ready",
      endpoint: ENDPOINT,
    });
  });

  it("keeps a verified session when setup fails so Retry can recover without another code", async () => {
    const ensureInstallation = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("network_unavailable"))
      .mockResolvedValueOnce({
        installation: {
          id: INSTALLATION_ID,
          clientInstanceId: UUID,
          name: "Test Mac",
          platform: "darwin",
        },
        credential: INSTALLATION_CREDENTIAL,
      });
    const client = readyClient({ ensureInstallation });
    const { service, store } = serviceFixture({ client });

    await expect(service.verifyCode("ada@example.com", "12345678")).resolves.toMatchObject({
      status: "error",
      email: "ada@example.com",
      message: expect.stringContaining("Check your internet"),
    });
    expect(store.read()).toMatchObject({
      [COMPANION_CLIENT_INSTANCE_FIELD]: UUID,
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-1",
    });
    await expect(service.retry()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });
    expect(client.verifyOTP).toHaveBeenCalledOnce();
  });

  it("clears a verified-only session when setup failed before any remote material existed", async () => {
    const client = readyClient({
      ensureInstallation: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
    });
    const { service, store } = serviceFixture({ client });

    await expect(service.verifyCode("ada@example.com", "12345678")).resolves.toMatchObject({
      status: "error",
    });
    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-1",
    });

    await expect(service.signOut()).resolves.toEqual({ available: true, status: "signed-out" });
    expect(client.signOut).toHaveBeenCalledWith(ACCOUNT_TOKEN);
    expect(store.read()).toEqual({ [COMPANION_CLIENT_INSTANCE_FIELD]: UUID });
  });

  it("can switch accounts after setup failed before creating an installation", async () => {
    const nextAccountToken = `signed.${"z".repeat(80)}`;
    const ensureInstallation = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("network_unavailable"))
      .mockResolvedValueOnce({
        installation: {
          id: INSTALLATION_ID,
          clientInstanceId: UUID,
          name: "Test Mac",
          platform: "darwin",
        },
        credential: INSTALLATION_CREDENTIAL,
      });
    const verifyOTP = vi
      .fn()
      .mockResolvedValueOnce({
        accountToken: ACCOUNT_TOKEN,
        user: { id: "user-1", email: "ada@example.com" },
      })
      .mockResolvedValueOnce({
        accountToken: nextAccountToken,
        user: { id: "user-2", email: "grace@example.com" },
      });
    const client = readyClient({ ensureInstallation, verifyOTP });
    const { service, store } = serviceFixture({ client });

    await service.verifyCode("ada@example.com", "12345678");
    await expect(service.verifyCode("grace@example.com", "87654321")).resolves.toEqual({
      available: true,
      status: "ready",
      email: "grace@example.com",
      endpoint: ENDPOINT,
    });
    expect(client.signOut).toHaveBeenCalledWith(ACCOUNT_TOKEN);
    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_TOKEN_FIELD]: nextAccountToken,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-2",
      [COMPANION_ACCOUNT_EMAIL_FIELD]: "grace@example.com",
    });
  });

  it("revokes an installation whose create response was lost before sign-out clears locally", async () => {
    const client = readyClient({
      ensureInstallation: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
      listInstallations: vi.fn(async () => [{
        id: INSTALLATION_ID,
        clientInstanceId: UUID,
        name: "Test Mac",
        platform: "darwin",
        appVersion: "1.2.3",
      }, {
        id: DUPLICATE_INSTALLATION_ID,
        clientInstanceId: UUID,
        name: "Lost duplicate",
        platform: "darwin",
        appVersion: "1.2.3",
      }]),
    });
    const { service, store } = serviceFixture({ client });

    await service.verifyCode("ada@example.com", "12345678");
    await expect(service.signOut()).resolves.toEqual({ available: true, status: "signed-out" });

    expect(client.listInstallations).toHaveBeenCalledWith(ACCOUNT_TOKEN);
    expect(client.revokeInstallation).toHaveBeenCalledWith(ACCOUNT_TOKEN, INSTALLATION_ID);
    expect(client.revokeInstallation).toHaveBeenCalledWith(
      ACCOUNT_TOKEN,
      DUPLICATE_INSTALLATION_ID,
    );
    expect(store.read()).toEqual({ [COMPANION_CLIENT_INSTANCE_FIELD]: UUID });
  });

  it("retains a response-lost session and cleanup intent when reconciliation is offline", async () => {
    const client = readyClient({
      ensureInstallation: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
      listInstallations: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
    });
    const { service, store } = serviceFixture({ client });

    await service.verifyCode("ada@example.com", "12345678");
    await expect(service.signOut()).resolves.toMatchObject({
      status: "error",
      email: "ada@example.com",
    });

    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-1",
      [COMPANION_CLIENT_INSTANCE_FIELD]: UUID,
    });
  });

  it("revokes an endpoint-ready installation whose provision response was lost", async () => {
    const client = readyClient({
      ensureEndpoint: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
      listInstallations: vi.fn(async () => [{
        id: INSTALLATION_ID,
        clientInstanceId: UUID,
        name: "Test Mac",
        platform: "darwin",
        appVersion: "1.2.3",
      }]),
    });
    const { service, store } = serviceFixture({ client });

    await service.verifyCode("ada@example.com", "12345678");
    await expect(service.signOut()).resolves.toEqual({ available: true, status: "signed-out" });

    expect(client.revokeInstallation).toHaveBeenCalledWith(ACCOUNT_TOKEN, INSTALLATION_ID);
    expect(store.read()).toEqual({ [COMPANION_CLIENT_INSTANCE_FIELD]: UUID });
  });

  it("cleans a response-lost endpoint before switching its stable UUID to another account", async () => {
    const nextAccountToken = `signed.${"n".repeat(80)}`;
    const verifyOTP = vi
      .fn()
      .mockResolvedValueOnce({
        accountToken: ACCOUNT_TOKEN,
        user: { id: "user-1", email: "ada@example.com" },
      })
      .mockResolvedValueOnce({
        accountToken: nextAccountToken,
        user: { id: "user-2", email: "grace@example.com" },
      });
    const ensureEndpoint = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("network_unavailable"))
      .mockResolvedValueOnce({ endpoint: { url: ENDPOINT }, connectorToken: CONNECTOR_TOKEN });
    const client = readyClient({
      verifyOTP,
      ensureEndpoint,
      listInstallations: vi.fn(async (token) => token === ACCOUNT_TOKEN
        ? [{
            id: INSTALLATION_ID,
            clientInstanceId: UUID,
            name: "Test Mac",
            platform: "darwin",
            appVersion: "1.2.3",
          }]
        : []),
    });
    const { service, store } = serviceFixture({ client });

    await service.verifyCode("ada@example.com", "12345678");
    await expect(service.verifyCode("grace@example.com", "87654321")).resolves.toEqual({
      available: true,
      status: "ready",
      email: "grace@example.com",
      endpoint: ENDPOINT,
    });

    expect(client.revokeInstallation).toHaveBeenCalledWith(ACCOUNT_TOKEN, INSTALLATION_ID);
    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_TOKEN_FIELD]: nextAccountToken,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-2",
    });
  });

  it("stops locally and preserves every cleanup credential until revocation succeeds", async () => {
    const listInstallations = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("network_unavailable"))
      .mockResolvedValueOnce([]);
    const client = readyClient({ listInstallations });
    const stopManagedEndpoint = vi.fn(async () => {});
    const { service, store } = serviceFixture({
      initial: signedCredentials(),
      client,
      stopManagedEndpoint,
    });

    const failed = await service.signOut();

    expect(failed).toMatchObject({ status: "error", email: "ada@example.com" });
    expect(stopManagedEndpoint).toHaveBeenCalled();
    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: INSTALLATION_CREDENTIAL,
      [MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
    });

    const recovered = await service.retry();
    expect(recovered).toEqual({ available: true, status: "signed-out" });
    expect(store.read()).toEqual({ [COMPANION_CLIENT_INSTANCE_FIELD]: UUID });
    expect(listInstallations).toHaveBeenCalledTimes(2);
  });

  it("stops hosted access before remote cleanup when the control plane is offline", async () => {
    const offline = async () => {
      throw new ControlPlaneError("network_unavailable");
    };
    const client = readyClient({
      health: vi.fn(offline),
      deleteEndpoint: vi.fn(offline),
      listInstallations: vi.fn(offline),
      revokeInstallation: vi.fn(offline),
    });
    const stopManagedEndpoint = vi.fn(async () => {});
    const { service, store } = serviceFixture({
      initial: signedCredentials(),
      client,
      stopManagedEndpoint,
    });

    await expect(service.signOut()).resolves.toMatchObject({
      status: "error",
      email: "ada@example.com",
    });

    expect(client.health).not.toHaveBeenCalled();
    expect(stopManagedEndpoint).toHaveBeenCalledOnce();
    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: INSTALLATION_CREDENTIAL,
      [MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
    });
  });

  it("uses a same-account reauthentication to finish pending cleanup instead of reprovisioning", async () => {
    const refreshedToken = `signed.${"r".repeat(80)}`;
    const client = readyClient({
      verifyOTP: vi.fn(async () => ({
        accountToken: refreshedToken,
        user: { id: "user-1", email: "ada@example.com" },
      })),
    });
    const initial = signedCredentials({
      [COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
    });
    const { service, store } = serviceFixture({ initial, client });

    await expect(service.verifyCode("ada@example.com", "12345678")).resolves.toEqual({
      available: true,
      status: "signed-out",
    });
    expect(client.revokeInstallation).toHaveBeenCalledWith(refreshedToken, INSTALLATION_ID);
    expect(client.signOut).toHaveBeenCalledWith(refreshedToken);
    expect(client.ensureInstallation).not.toHaveBeenCalled();
    expect(client.ensureEndpoint).not.toHaveBeenCalled();
    expect(store.read()).toEqual({ [COMPANION_CLIENT_INSTANCE_FIELD]: UUID });
  });

  it("does not overwrite a previous account when switching cleanup fails", async () => {
    const newAccountToken = `signed.${"z".repeat(80)}`;
    const client = readyClient({
      verifyOTP: vi.fn(async () => ({
        accountToken: newAccountToken,
        user: { id: "user-2", email: "grace@example.com" },
      })),
      revokeInstallation: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
      listInstallations: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
    });
    const { service, store } = serviceFixture({ initial: signedCredentials(), client });

    await expect(service.verifyCode("grace@example.com", "12345678")).resolves.toMatchObject({
      status: "error",
      email: "ada@example.com",
      message: expect.stringContaining("Check your internet"),
    });
    expect(store.read()[COMPANION_ACCOUNT_USER_ID_FIELD]).toBe("user-1");
    expect(store.read()[COMPANION_ACCOUNT_TOKEN_FIELD]).toBe(ACCOUNT_TOKEN);
    expect(client.signOut).toHaveBeenCalledWith(newAccountToken);
  });

  it("treats an already removed installation as an idempotent sign-out", async () => {
    const client = readyClient({
      revokeInstallation: vi.fn(async () => {
        throw new ControlPlaneError("not_found", 404);
      }),
    });
    const { service, store } = serviceFixture({ initial: signedCredentials(), client });

    await expect(service.signOut()).resolves.toEqual({ available: true, status: "signed-out" });
    expect(store.read()).toEqual({ [COMPANION_CLIENT_INSTANCE_FIELD]: UUID });
  });
});
