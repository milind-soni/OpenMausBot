import { describe, expect, it, vi } from "vitest";

import { ControlPlaneError } from "./control-plane-client.mjs";
import {
  COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD,
  COMPANION_ACCOUNT_EMAIL_FIELD,
  COMPANION_ACCOUNT_TOKEN_FIELD,
  COMPANION_ACCOUNT_USER_ID_FIELD,
  COMPANION_CLIENT_INSTANCE_FIELD,
  COMPANION_ENDPOINT_PAUSED_FIELD,
  COMPANION_TUNNEL_RETIRED_FIELD,
  COMPANION_TUNNEL_WAITING_FIELD,
  COMPANION_ENDPOINT_RELEASE_PENDING_FIELD,
  COMPANION_INSTALLATION_CREDENTIAL_FIELD,
  COMPANION_INSTALLATION_EXPIRY_FIELD,
  COMPANION_INSTALLATION_ID_FIELD,
  createCompanionAccountService,
  friendlyCompanionAccountError,
  managedEndpointNeed,
  PHONE_UNUSED_RELEASE_MS,
  resolveCompanionControlPlaneURL,
} from "./companion-account-service.mjs";
import {
  MANAGED_COMPANION_ENDPOINT_FIELD,
  MANAGED_COMPANION_ORIGIN_VERSION,
  MANAGED_COMPANION_ORIGIN_VERSION_FIELD,
  MANAGED_COMPANION_RELEASE_AT_FIELD,
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

  it("persists installation recovery credentials before the complete endpoint provision", async () => {
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
    expect(store.writes).toHaveLength(3);
    expect(store.writes[1]).toMatchObject({
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_INSTALLATION_ID_FIELD]: INSTALLATION_ID,
      [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: INSTALLATION_CREDENTIAL,
      [COMPANION_INSTALLATION_EXPIRY_FIELD]: expect.any(Number),
    });
    expect(store.writes[1]).not.toHaveProperty(MANAGED_COMPANION_ENDPOINT_FIELD);
    expect(store.writes[1]).not.toHaveProperty(MANAGED_COMPANION_TOKEN_FIELD);
    expect(store.update.mock.invocationCallOrder[1]).toBeLessThan(
      client.ensureEndpoint.mock.invocationCallOrder[0],
    );
    expect(store.writes[2]).toMatchObject(persisted);
    expect(activatePersistedEndpoint).toHaveBeenCalledOnce();

    await service.restore();
    expect(store.writes).toHaveLength(3);
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

  it("reuses the installation credential after initial endpoint provisioning fails", async () => {
    const ensureEndpoint = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("endpoint_unavailable", 502))
      .mockResolvedValueOnce({ endpoint: { url: ENDPOINT }, connectorToken: CONNECTOR_TOKEN });
    const client = readyClient({ ensureEndpoint });
    const activatePersistedEndpoint = vi.fn(async () => ({ status: "ready", ready: true }));
    const { service, store } = serviceFixture({ client, activatePersistedEndpoint });

    await expect(service.verifyCode("ada@example.com", "12345678")).resolves.toMatchObject({
      status: "error",
      email: "ada@example.com",
    });
    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_INSTALLATION_ID_FIELD]: INSTALLATION_ID,
      [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: INSTALLATION_CREDENTIAL,
      [COMPANION_INSTALLATION_EXPIRY_FIELD]: expect.any(Number),
    });
    expect(store.read()).not.toHaveProperty(MANAGED_COMPANION_ENDPOINT_FIELD);
    expect(store.read()).not.toHaveProperty(MANAGED_COMPANION_TOKEN_FIELD);
    expect(activatePersistedEndpoint).not.toHaveBeenCalled();

    await expect(service.retry()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });
    expect(client.ensureInstallation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      accountToken: ACCOUNT_TOKEN,
      currentCredential: INSTALLATION_CREDENTIAL,
      clientInstanceId: UUID,
    }));
    expect(ensureEndpoint).toHaveBeenNthCalledWith(2, INSTALLATION_CREDENTIAL, { appVersion: "1.2.3" });
    expect(client.verifyOTP).toHaveBeenCalledOnce();
    expect(client.revokeInstallation).not.toHaveBeenCalled();
    expect(activatePersistedEndpoint).toHaveBeenCalledOnce();
  });

  it("restores an interrupted endpoint provision with the saved installation credential", async () => {
    const failedClient = readyClient({
      ensureEndpoint: vi.fn(async () => {
        throw new ControlPlaneError("endpoint_unavailable", 502);
      }),
    });
    const failed = serviceFixture({ client: failedClient });
    await failed.service.verifyCode("ada@example.com", "12345678");
    const restored = serviceFixture({ initial: failed.store.read() });

    await expect(restored.service.restore()).resolves.toMatchObject({
      status: "ready",
      endpoint: ENDPOINT,
    });
    expect(restored.client.ensureInstallation).toHaveBeenCalledWith(expect.objectContaining({
      accountToken: ACCOUNT_TOKEN,
      currentCredential: INSTALLATION_CREDENTIAL,
      clientInstanceId: UUID,
    }));
    expect(restored.client.verifyOTP).not.toHaveBeenCalled();
  });

  it("revokes a new installation if its credential cannot be saved before provisioning", async () => {
    const { client, service, store } = serviceFixture();
    const persist = store.update.getMockImplementation();
    store.update.mockImplementationOnce(persist).mockRejectedValueOnce(new Error("save failed"));

    await expect(service.verifyCode("ada@example.com", "12345678")).resolves.toMatchObject({
      status: "error",
    });
    expect(client.ensureEndpoint).not.toHaveBeenCalled();
    expect(client.revokeInstallation).toHaveBeenCalledWith(ACCOUNT_TOKEN, INSTALLATION_ID);
    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_CLIENT_INSTANCE_FIELD]: UUID,
    });
    expect(store.read()).not.toHaveProperty(COMPANION_INSTALLATION_CREDENTIAL_FIELD);
  });

  it("preserves an established installation when its pre-provision credential write fails", async () => {
    const initial = signedCredentials();
    const { client, service, store } = serviceFixture({ initial });
    store.update.mockRejectedValueOnce(new Error("save failed"));

    await service.retry();

    expect(client.ensureEndpoint).not.toHaveBeenCalled();
    expect(client.deleteEndpoint).not.toHaveBeenCalled();
    expect(client.revokeInstallation).not.toHaveBeenCalled();
    expect(store.read()).toEqual(initial);
  });

  it("revokes a recovered installation when its rotated credential cannot be saved", async () => {
    const initial = signedCredentials();
    const client = readyClient();
    const recovered = await client.ensureInstallation();
    client.ensureInstallation.mockResolvedValue({ ...recovered, credential: `${INSTALLATION_CREDENTIAL}-rotated` });
    const { service, store } = serviceFixture({ initial, client });
    store.update.mockRejectedValueOnce(new Error("save failed"));

    await service.retry();

    expect(client.ensureEndpoint).not.toHaveBeenCalled();
    expect(client.revokeInstallation).toHaveBeenCalledWith(ACCOUNT_TOKEN, INSTALLATION_ID);
    expect(store.read()).toEqual(initial);
  });

  it("cleans up provisioned resources if saving the endpoint fails", async () => {
    const activatePersistedEndpoint = vi.fn();
    const { client, service, store } = serviceFixture({ activatePersistedEndpoint });
    const persist = store.update.getMockImplementation();
    store.update
      .mockImplementationOnce(persist)
      .mockImplementationOnce(persist)
      .mockRejectedValueOnce(new Error("save failed"));

    await expect(service.verifyCode("ada@example.com", "12345678")).resolves.toMatchObject({
      status: "error",
    });
    expect(client.deleteEndpoint).toHaveBeenCalledWith(INSTALLATION_CREDENTIAL);
    expect(client.revokeInstallation).toHaveBeenCalledWith(ACCOUNT_TOKEN, INSTALLATION_ID);
    expect(activatePersistedEndpoint).not.toHaveBeenCalled();
    expect(store.read()[COMPANION_INSTALLATION_CREDENTIAL_FIELD]).toBe(INSTALLATION_CREDENTIAL);
    expect(store.read()).not.toHaveProperty(MANAGED_COMPANION_ENDPOINT_FIELD);
    expect(store.read()).not.toHaveProperty(MANAGED_COMPANION_TOKEN_FIELD);
  });

  it("explains the service failure and gives pairing alternatives with a support reference", async () => {
    const requestId = "44444444-4444-4444-8444-444444444444";
    const client = readyClient({
      ensureEndpoint: vi.fn(async () => {
        throw new ControlPlaneError("endpoint_unavailable", 502, requestId);
      }),
    });
    const { service } = serviceFixture({ client });

    await expect(service.verifyCode("ada@example.com", "12345678")).resolves.toMatchObject({
      status: "error",
      message: `The secure connection service could not finish setup. Local Wi-Fi and Tailscale pairing still work. If this keeps happening, contact support with the error reference. Reference: ${requestId}.`,
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
    expect(store.read()[COMPANION_INSTALLATION_CREDENTIAL_FIELD]).toBe(INSTALLATION_CREDENTIAL);
    await expect(service.signOut()).resolves.toEqual({ available: true, status: "signed-out" });

    expect(client.deleteEndpoint).toHaveBeenCalledWith(INSTALLATION_CREDENTIAL);
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

    expect(client.deleteEndpoint).toHaveBeenCalledWith(INSTALLATION_CREDENTIAL);
    expect(client.revokeInstallation).toHaveBeenCalledWith(ACCOUNT_TOKEN, INSTALLATION_ID);
    expect(client.ensureInstallation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      accountToken: nextAccountToken,
      currentCredential: "",
      clientInstanceId: UUID,
    }));
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

const RECLAIMED_TOKEN = `eyJ${"e".repeat(100)}`;

function manualTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimer: vi.fn((callback, milliseconds) => {
      const id = next;
      next += 1;
      pending.set(id, { callback, milliseconds });
      return id;
    }),
    clearTimer: vi.fn((id) => {
      pending.delete(id);
    }),
    delays: () => [...pending.values()].map((timer) => timer.milliseconds),
    fire() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, timer] of due) timer.callback();
    },
  };
}

describe("Companion account background recovery", () => {
  it("names provider capacity honestly and retries with backoff that honours Retry-After", async () => {
    const timers = manualTimers();
    const ensureEndpoint = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("endpoint_capacity", 503, "", 600_000))
      .mockRejectedValueOnce(new ControlPlaneError("endpoint_capacity", 503))
      .mockResolvedValueOnce({ endpoint: { url: ENDPOINT }, connectorToken: CONNECTOR_TOKEN });
    const client = readyClient({ ensureEndpoint });
    const { service, store } = serviceFixture({
      client,
      autoRecover: true,
      autoRetryBaseMs: 1_000,
      autoRetryMaxMs: 1_000_000,
      random: () => 0.5,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await expect(service.verifyCode("ada@example.com", "12345678")).resolves.toMatchObject({
      status: "error",
      message: "Secure HTTPS links are temporarily full. Try again in 10 minutes, or pair on this Wi-Fi or with Tailscale.",
    });
    expect(timers.delays()).toEqual([600_000]);

    timers.fire();
    await vi.waitFor(() => expect(ensureEndpoint).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(timers.delays()).toEqual([2_000]));

    timers.fire();
    await vi.waitFor(() => expect(store.read()[MANAGED_COMPANION_TOKEN_FIELD]).toBe(CONNECTOR_TOKEN));
    expect(timers.delays()).toEqual([]);
    expect(client.verifyOTP).toHaveBeenCalledOnce();
    expect(client.revokeInstallation).not.toHaveBeenCalled();
    await expect(service.state()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });
  });

  it("says a provider rate limit is temporary, how long to wait, and retries no sooner than asked", async () => {
    const requestId = "66666666-6666-4666-8666-666666666666";
    const timers = manualTimers();
    const ensureEndpoint = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("endpoint_rate_limited", 503, requestId, 120_000))
      .mockResolvedValueOnce({ endpoint: { url: ENDPOINT }, connectorToken: CONNECTOR_TOKEN });
    const client = readyClient({ ensureEndpoint });
    const { service, store } = serviceFixture({
      client,
      autoRecover: true,
      autoRetryBaseMs: 1_000,
      autoRetryMaxMs: 1_000_000,
      random: () => 0.5,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const failed = await service.verifyCode("ada@example.com", "12345678");
    expect(failed).toMatchObject({
      status: "error",
      message: `The secure connection service is busy right now. Local Wi-Fi and Tailscale pairing still work; try again in 2 minutes. Reference: ${requestId}.`,
    });
    expect(failed.message).not.toContain("could not finish setup");
    expect(timers.delays()).toEqual([120_000]);

    timers.fire();
    await vi.waitFor(() => expect(store.read()[MANAGED_COMPANION_TOKEN_FIELD]).toBe(CONNECTOR_TOKEN));
    expect(ensureEndpoint).toHaveBeenCalledTimes(2);
    expect(timers.delays()).toEqual([]);
  });

  it("phrases the rate-limit wait from the Retry-After it was given", () => {
    const message = (retryAfterMs) =>
      friendlyCompanionAccountError(new ControlPlaneError("endpoint_rate_limited", 503, "", retryAfterMs));
    expect(message(60_000)).toMatch(/try again in 60 seconds\.$/);
    expect(message(30_000)).toMatch(/try again in 30 seconds\.$/);
    expect(message(300_000)).toMatch(/try again in 5 minutes\.$/);
    expect(message(0)).toMatch(/try again in a few minutes\.$/);
  });

  it("logs each failed setup step with its code and support reference, and nothing secret", async () => {
    const requestId = "55555555-5555-4555-8555-555555555555";
    const timers = manualTimers();
    const log = vi.fn();
    const client = readyClient({
      ensureEndpoint: vi.fn(async () => {
        throw new ControlPlaneError("endpoint_unavailable", 502, requestId);
      }),
    });
    const { service } = serviceFixture({
      client,
      log,
      autoRecover: true,
      autoRetryBaseMs: 1_000,
      autoRetryMaxMs: 1_000_000,
      random: () => 0.5,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await service.verifyCode("ada@example.com", "12345678");

    const lines = log.mock.calls.map(([line]) => line);
    expect(lines).toEqual([
      `companion account: setup failed code=endpoint_unavailable status=502 ref=${requestId}`,
      "companion account: retrying endpoint_unavailable in 1s (attempt 1)",
    ]);
    for (const secret of [ACCOUNT_TOKEN, CONNECTOR_TOKEN, INSTALLATION_ID, INSTALLATION_CREDENTIAL, ENDPOINT, "ada@example.com"]) {
      expect(lines.join("\n")).not.toContain(secret);
    }
  });

  it("finishes a setup step the same way when the log cannot be written", async () => {
    const client = readyClient({
      ensureEndpoint: vi.fn(async () => {
        throw new ControlPlaneError("endpoint_unavailable", 502);
      }),
    });
    const { service } = serviceFixture({
      client,
      log: () => {
        throw new Error("disk full");
      },
    });

    await expect(service.verifyCode("ada@example.com", "12345678")).resolves.toMatchObject({
      status: "error",
    });
  });

  it("does not retry on its own without autoRecover or for failures that need the user", async () => {
    for (const [autoRecover, error] of [
      [false, new ControlPlaneError("endpoint_capacity", 503, "", 600_000)],
      [true, new ControlPlaneError("installation_limit_reached", 409)],
      [true, new ControlPlaneError("unauthorized", 401)],
    ]) {
      const timers = manualTimers();
      const client = readyClient({ ensureEndpoint: vi.fn(async () => { throw error; }) });
      const { service } = serviceFixture({
        client,
        autoRecover,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      });
      await service.verifyCode("ada@example.com", "12345678");
      expect(timers.setTimer).not.toHaveBeenCalled();
    }
  });

  it("caps the backoff and stops retrying after sign-out", async () => {
    const timers = manualTimers();
    const ensureEndpoint = vi.fn(async () => {
      throw new ControlPlaneError("endpoint_unavailable", 502);
    });
    const incomplete = signedCredentials();
    delete incomplete[MANAGED_COMPANION_ENDPOINT_FIELD];
    delete incomplete[MANAGED_COMPANION_TOKEN_FIELD];
    const { service } = serviceFixture({
      initial: incomplete,
      client: readyClient({ ensureEndpoint }),
      autoRecover: true,
      autoRetryBaseMs: 1_000,
      autoRetryMaxMs: 4_000,
      random: () => 0.5,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await service.retry();
    const seen = [...timers.delays()];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      timers.fire();
      await vi.waitFor(() => expect(ensureEndpoint).toHaveBeenCalledTimes(attempt + 2));
      await vi.waitFor(() => expect(timers.delays()).toHaveLength(1));
      seen.push(...timers.delays());
    }
    expect(seen).toEqual([1_000, 2_000, 4_000, 4_000]);

    await service.signOut();
    expect(timers.pending.size).toBe(0);
  });

  it("re-provisions a reclaimed endpoint at launch behind the same address without a new sign-in", async () => {
    for (const reclaimed of [null, { url: ENDPOINT, status: "deleted" }, { url: ENDPOINT, status: "deleting" }]) {
      const client = readyClient({
        getEndpoint: vi.fn(async () => reclaimed),
        ensureEndpoint: vi.fn(async () => ({
          endpoint: { url: ENDPOINT },
          connectorToken: RECLAIMED_TOKEN,
        })),
      });
      const activatePersistedEndpoint = vi.fn(async () => ({ status: "ready", ready: true }));
      const { service, store } = serviceFixture({
        initial: signedCredentials(),
        client,
        autoRecover: true,
        activatePersistedEndpoint,
        setTimer: manualTimers().setTimer,
      });

      await expect(service.restore()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });
      expect(client.getEndpoint).toHaveBeenCalledWith(INSTALLATION_CREDENTIAL);
      expect(client.ensureEndpoint).toHaveBeenCalledOnce();
      expect(store.read()[MANAGED_COMPANION_TOKEN_FIELD]).toBe(RECLAIMED_TOKEN);
      expect(activatePersistedEndpoint).toHaveBeenCalledOnce();
      expect(client.verifyOTP).not.toHaveBeenCalled();
      expect(client.revokeInstallation).not.toHaveBeenCalled();
    }
  });

  it("trusts the saved address when the endpoint is live, the check fails, or Remote access is off", async () => {
    const cases = [
      { getEndpoint: vi.fn(async () => ({ url: ENDPOINT, status: "ready" })), on: true, checked: true },
      {
        getEndpoint: vi.fn(async () => {
          throw new ControlPlaneError("network_unavailable");
        }),
        on: true,
        checked: true,
      },
      { getEndpoint: vi.fn(async () => null), on: false, checked: false },
    ];
    for (const { getEndpoint, on, checked } of cases) {
      const client = readyClient({ getEndpoint });
      const initial = signedCredentials();
      const { service, store } = serviceFixture({
        initial,
        client,
        autoRecover: true,
        companionIsOn: () => on,
        setTimer: manualTimers().setTimer,
      });
      await expect(service.restore()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });
      expect(getEndpoint).toHaveBeenCalledTimes(checked ? 1 : 0);
      expect(client.ensureEndpoint).not.toHaveBeenCalled();
      expect(store.read()).toEqual(initial);
    }
  });

  it("checks the endpoint once the connector cannot come up after Remote access is turned on", async () => {
    const timers = manualTimers();
    let clock = 1_000_000;
    let on = false;
    let connection = { status: "stopped", ready: false };
    const client = readyClient({
      getEndpoint: vi.fn(async () => null),
      ensureEndpoint: vi.fn(async () => ({
        endpoint: { url: ENDPOINT },
        connectorToken: RECLAIMED_TOKEN,
      })),
    });
    const { service, store } = serviceFixture({
      initial: signedCredentials(),
      client,
      autoRecover: true,
      companionIsOn: () => on,
      managedConnectionState: () => connection,
      now: () => clock,
      firstEndpointCheckMs: 100,
      endpointCheckIntervalMs: 1_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await service.restore();
    expect(client.getEndpoint).not.toHaveBeenCalled();
    expect(timers.delays()).toEqual([100]);

    timers.fire();
    expect(client.getEndpoint).not.toHaveBeenCalled();
    expect(timers.delays()).toEqual([1_000]);

    on = true;
    connection = { status: "retrying", ready: false };
    timers.fire();
    await vi.waitFor(() => expect(client.ensureEndpoint).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(store.read()[MANAGED_COMPANION_TOKEN_FIELD]).toBe(RECLAIMED_TOKEN));

    connection = { status: "unavailable", ready: false };
    clock += 5_000;
    timers.fire();
    await Promise.resolve();
    expect(client.getEndpoint).toHaveBeenCalledOnce();
    connection = { status: "retrying", ready: false };
    client.getEndpoint.mockResolvedValue({ url: ENDPOINT, status: "ready" });
    timers.fire();
    await vi.waitFor(() => expect(client.getEndpoint).toHaveBeenCalledTimes(2));
    timers.fire();
    await Promise.resolve();
    expect(client.getEndpoint).toHaveBeenCalledTimes(2);
    expect(client.ensureEndpoint).toHaveBeenCalledOnce();

    service.dispose();
    expect(timers.pending.size).toBe(0);
  });

  it("replaces a reclaimed tunnel while the connector still reports ready after a long sleep", async () => {
    for (const serverView of [null, { url: ENDPOINT, status: "deleted" }, { url: ENDPOINT, status: "error" }]) {
      const timers = manualTimers();
      let clock = 1_000_000;
      const client = readyClient({
        getEndpoint: vi.fn(async () => ({ url: ENDPOINT, status: "ready" })),
        ensureEndpoint: vi.fn(async () => ({
          endpoint: { url: ENDPOINT },
          connectorToken: RECLAIMED_TOKEN,
        })),
      });
      const activatePersistedEndpoint = vi.fn(async () => ({ status: "ready", ready: true }));
      const { service, store } = serviceFixture({
        initial: signedCredentials(),
        client,
        autoRecover: true,
        activatePersistedEndpoint,
        managedConnectionState: () => ({ status: "ready", ready: true }),
        now: () => clock,
        firstEndpointCheckMs: 100,
        endpointCheckIntervalMs: 1_000,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      });

      await expect(service.restore()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });
      expect(client.getEndpoint).toHaveBeenCalledOnce();

      clock += 30 * 24 * 60 * 60_000;
      client.getEndpoint.mockResolvedValue(serverView);
      timers.fire();
      await vi.waitFor(() => expect(store.read()[MANAGED_COMPANION_TOKEN_FIELD]).toBe(RECLAIMED_TOKEN));
      expect(client.getEndpoint).toHaveBeenCalledTimes(2);
      expect(client.ensureEndpoint).toHaveBeenCalledOnce();
      expect(client.ensureEndpoint).toHaveBeenCalledWith(INSTALLATION_CREDENTIAL, { appVersion: "1.2.3" });
      expect(store.read()[MANAGED_COMPANION_ENDPOINT_FIELD]).toBe(ENDPOINT);
      await vi.waitFor(() => expect(activatePersistedEndpoint).toHaveBeenCalledOnce());
      expect(client.verifyOTP).not.toHaveBeenCalled();
      expect(client.revokeInstallation).not.toHaveBeenCalled();
      await expect(service.state()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });
      service.dispose();
    }
  });

  it("checks on every interval tick, even when the last check landed just after its own tick", async () => {
    const timers = manualTimers();
    let clock = 1_000_000;
    const client = readyClient({ getEndpoint: vi.fn(async () => ({ url: ENDPOINT, status: "ready" })) });
    const { service } = serviceFixture({
      initial: signedCredentials(),
      client,
      autoRecover: true,
      now: () => clock,
      firstEndpointCheckMs: 100,
      endpointCheckIntervalMs: 1_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await service.restore();
    expect(client.getEndpoint).toHaveBeenCalledOnce();
    clock += 100;
    timers.fire();
    await Promise.resolve();
    expect(client.getEndpoint).toHaveBeenCalledOnce();
    // Each check is recorded a few milliseconds after its own tick, as on a busy event loop.
    let tickAt = 1_000_000;
    for (let tick = 2; tick <= 4; tick += 1) {
      tickAt += 1_000;
      clock = tickAt;
      timers.fire();
      clock += 5;
      await vi.waitFor(() => expect(client.getEndpoint).toHaveBeenCalledTimes(tick));
    }
    expect(client.ensureEndpoint).not.toHaveBeenCalled();
    service.dispose();
  });

  it("recovers a rejected installation credential through the account session", async () => {
    const timers = manualTimers();
    const client = readyClient({
      getEndpoint: vi.fn(async () => {
        throw new ControlPlaneError("unauthorized", 401);
      }),
      ensureEndpoint: vi.fn(async () => ({
        endpoint: { url: ENDPOINT },
        connectorToken: RECLAIMED_TOKEN,
      })),
    });
    const { service, store } = serviceFixture({
      initial: signedCredentials(),
      client,
      autoRecover: true,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await expect(service.restore()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });
    expect(client.ensureInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ accountToken: ACCOUNT_TOKEN, currentCredential: INSTALLATION_CREDENTIAL }),
    );
    expect(client.ensureEndpoint).toHaveBeenCalledOnce();
    expect(store.read()[MANAGED_COMPANION_TOKEN_FIELD]).toBe(RECLAIMED_TOKEN);
    expect(store.read()[MANAGED_COMPANION_ENDPOINT_FIELD]).toBe(ENDPOINT);
    service.dispose();
  });

  it("asks for a sign-in when the installation credential and the session have both expired", async () => {
    const timers = manualTimers();
    let clock = 1_000_000;
    const client = readyClient({
      getEndpoint: vi.fn(async () => {
        throw new ControlPlaneError("unauthorized", 401);
      }),
      ensureInstallation: vi.fn(async () => {
        throw new ControlPlaneError("unauthorized", 401);
      }),
    });
    const initial = signedCredentials();
    const { service, store } = serviceFixture({
      initial,
      client,
      autoRecover: true,
      managedConnectionState: () => ({ status: "retrying", ready: false }),
      now: () => clock,
      firstEndpointCheckMs: 100,
      endpointCheckIntervalMs: 1_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await expect(service.restore()).resolves.toMatchObject({
      status: "signed-out",
      email: "ada@example.com",
      message: expect.stringContaining("sign-in expired"),
    });
    expect(client.ensureEndpoint).not.toHaveBeenCalled();
    expect(store.read()).toEqual(initial);

    for (let tick = 0; tick < 3; tick += 1) {
      clock += 1_000;
      timers.fire();
      await Promise.resolve();
    }
    expect(client.getEndpoint).toHaveBeenCalledOnce();
    expect(client.ensureInstallation).toHaveBeenCalledOnce();
    service.dispose();
  });
});

const HOUR_MS = 60 * 60_000;
const LAUNCH_AT = 1_700_000_000_000;
const WATCHDOG_INTERVAL_MS = 1_000;
const ADDRESS_FIELDS = [
  MANAGED_COMPANION_ENDPOINT_FIELD,
  MANAGED_COMPANION_TOKEN_FIELD,
  MANAGED_COMPANION_ORIGIN_VERSION_FIELD,
  MANAGED_COMPANION_RELEASE_AT_FIELD,
];

function signedInWithoutAddress() {
  const document = signedCredentials();
  for (const field of ADDRESS_FIELDS) delete document[field];
  return document;
}

function fireTimers(timers, accept) {
  const due = [...timers.pending];
  for (const [id, timer] of due) {
    if (!accept(timer.milliseconds)) continue;
    timers.pending.delete(id);
    timer.callback();
  }
}

/** Every fake answers in microtasks, so one macrotask turn lets a timer's serialized work finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function onDemandFixture({ initial = signedCredentials(), client = readyClient(), ...overrides } = {}) {
  const timers = manualTimers();
  const clock = { now: LAUNCH_AT };
  const companion = { need: false, on: true, connection: { status: "ready", ready: true } };
  const log = vi.fn();
  const stopManagedEndpoint = vi.fn(async () => {});
  const activatePersistedEndpoint = vi.fn(async () => ({ status: "ready", ready: true }));
  const fixture = serviceFixture({
    initial,
    client,
    onDemand: true,
    autoRecover: true,
    managedEndpointNeeded: vi.fn(async () => companion.need),
    companionIsOn: () => companion.on,
    managedConnectionState: () => companion.connection,
    activatePersistedEndpoint,
    stopManagedEndpoint,
    now: () => clock.now,
    random: () => 0.5,
    firstEndpointCheckMs: 100,
    endpointCheckIntervalMs: WATCHDOG_INTERVAL_MS,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    log,
    ...overrides,
  });
  return {
    ...fixture,
    timers,
    clock,
    companion,
    log,
    stopManagedEndpoint,
    activatePersistedEndpoint,
    lines: () => log.mock.calls.map(([line]) => line),
    retries: () => timers.delays().filter((delay) => delay > WATCHDOG_INTERVAL_MS),
    async watchdog() {
      fireTimers(timers, (delay) => delay <= WATCHDOG_INTERVAL_MS);
      await settle();
    },
    async retryTimer() {
      fireTimers(timers, (delay) => delay > WATCHDOG_INTERVAL_MS);
      await settle();
    },
  };
}

describe("Companion account on demand", () => {
  it("reads the need from the running companion, and anything unclear as can't tell", () => {
    const answer = (overrides) => ({ enabled: true, devices: [], pairing: null, ...overrides });
    const pairing = { code: "123456", token: `omb_pair_${"a".repeat(43)}`, expiresAt: LAUNCH_AT };
    expect(managedEndpointNeed(answer({ devices: [{ id: "phone-1", name: "Ada" }] }))).toBe(true);
    expect(managedEndpointNeed(answer({ pairing }))).toBe(true);
    expect(managedEndpointNeed(answer())).toBe(false);
    for (const unclear of [
      null,
      undefined,
      "on",
      answer({ enabled: false }),
      answer({ error: "the companion is not responding" }),
      answer({ devicesUnreadable: true }),
      answer({ devices: undefined }),
    ]) {
      expect(managedEndpointNeed(unclear)).toBeNull();
    }
  });

  it("needs a tunnel only for an old phone seen this month once the encrypted connection is on", () => {
    const now = LAUNCH_AT;
    const on = (devices, extra = {}) => ({ enabled: true, devices, pairing: null, e2e: { enabled: true }, ...extra });
    const pairing = { code: "123456", token: `omb_pair_${"a".repeat(43)}`, expiresAt: now };
    expect(managedEndpointNeed(on([{ id: "old", lastSeenAt: now - HOUR_MS }]), now)).toBe(true);
    expect(managedEndpointNeed(on([{ id: "new", lastSeenAt: now, e2eAt: now - HOUR_MS }]), now)).toBe(false);
    expect(managedEndpointNeed(on([{ id: "stale", lastSeenAt: now - 31 * 24 * HOUR_MS }]), now)).toBe("unused");
    expect(managedEndpointNeed(on([{ id: "new", lastSeenAt: now, e2eAt: now }, { id: "stale", lastSeenAt: now - 31 * 24 * HOUR_MS }]), now)).toBe("unused");
    expect(managedEndpointNeed(on([], { pairing }), now)).toBe(false);
    expect(managedEndpointNeed({ ...on([], { pairing }), e2e: { enabled: false } }, now)).toBe(true);
  });

  it("reports the old phones with a tunnel request, and takes 409 relay_capable as no tunnel needed", async () => {
    const refused = Object.assign(new Error("relay capable"), { code: "relay_capable", status: 409 });
    const client = readyClient({ ensureEndpoint: vi.fn(async () => Promise.reject(refused)) });
    const f = onDemandFixture({ initial: {}, client, relay: { capable: () => false, legacyDevices: async () => 0 } });
    f.companion.need = true;
    await f.service.requestCode("ada@example.com");
    const state = await f.service.verifyCode("ada@example.com", "12345678");
    expect(client.ensureEndpoint).toHaveBeenCalledWith(expect.any(String), { appVersion: "1.2.3", legacyDevices: 0 });
    expect(state).toEqual({ available: true, status: "ready", email: "ada@example.com" });
    f.service.dispose();
  });

  it("stops the connector, forgets the address and says so when old phone apps no longer get a tunnel", async () => {
    const retired = new ControlPlaneError("relay_capable", 409, "", 0, "retired");
    expect(retired.tunnel).toBe("retired");
    expect(new ControlPlaneError("relay_capable", 409, "", 0, "anything").tunnel).toBeNull();
    expect(new ControlPlaneError("endpoint_capacity", 503, "", 0, "retired").tunnel).toBeNull();
    const client = readyClient({ ensureEndpoint: vi.fn(async () => Promise.reject(retired)) });
    const f = onDemandFixture({ client, relay: { capable: () => true, legacyDevices: async () => 1 } });
    f.companion.need = true;
    const state = await f.service.retry();
    expect(client.ensureEndpoint).toHaveBeenCalledWith(expect.any(String), { appVersion: "1.2.3", legacyDevices: 1 });
    expect(state).toEqual({ available: true, status: "ready", email: "ada@example.com", tunnelRetired: true });
    expect(f.store.read()[COMPANION_TUNNEL_RETIRED_FIELD]).toBe(true);
    expect(f.store.read()[COMPANION_TUNNEL_WAITING_FIELD]).toBe(true);
    expect(f.store.read()).not.toHaveProperty(MANAGED_COMPANION_ENDPOINT_FIELD);
    expect(f.stopManagedEndpoint).toHaveBeenCalled();
    f.service.dispose();
  });

  it("keeps asking on the watchdog after the address ended or the accounts were full, so a relay outage hands it back", async () => {
    for (const tunnel of ["retired", "full"]) {
      const refused = new ControlPlaneError("relay_capable", 409, "", 0, tunnel);
      const client = readyClient({ ensureEndpoint: vi.fn(async () => Promise.reject(refused)) });
      const f = onDemandFixture({ client, relay: { capable: () => true, legacyDevices: async () => 1 } });
      f.companion.need = true;
      await f.service.restore();
      await f.service.retry();
      expect(client.ensureEndpoint).toHaveBeenCalledTimes(1);
      expect(f.store.read()[COMPANION_TUNNEL_WAITING_FIELD]).toBe(true);
      expect(f.store.read()).not.toHaveProperty(MANAGED_COMPANION_ENDPOINT_FIELD);

      // Nobody opens Phone & devices: each watchdog tick asks again, and after the hour a manual Retry counts for.
      for (let tick = 2; tick <= 5; tick += 1) {
        f.clock.now += HOUR_MS;
        await f.watchdog();
        expect(client.ensureEndpoint, `${tunnel} tick ${tick}`).toHaveBeenCalledTimes(tick);
      }
      expect(await f.service.state()).toEqual({
        available: true, status: "ready", email: "ada@example.com", ...(tunnel === "retired" ? { tunnelRetired: true } : {}),
      });

      // The relay is switched off (or room frees up): the next tick gets the address back and the notice goes.
      client.ensureEndpoint.mockImplementation(async () => ({ endpoint: { url: ENDPOINT }, connectorToken: CONNECTOR_TOKEN }));
      f.clock.now += HOUR_MS;
      await f.watchdog();
      expect(f.store.read()[MANAGED_COMPANION_ENDPOINT_FIELD]).toBe(ENDPOINT);
      expect(f.store.read()).not.toHaveProperty(COMPANION_TUNNEL_RETIRED_FIELD);
      expect(f.store.read()).not.toHaveProperty(COMPANION_TUNNEL_WAITING_FIELD);
      expect(await f.service.state()).not.toHaveProperty("tunnelRetired");
      f.service.dispose();
    }
  });

  it("stops asking once no old phone needs an address, and after a plain relay_capable", async () => {
    const refused = new ControlPlaneError("relay_capable", 409, "", 0, "retired");
    const client = readyClient({ ensureEndpoint: vi.fn(async () => Promise.reject(refused)) });
    const f = onDemandFixture({ client, relay: { capable: () => true, legacyDevices: async () => 1 } });
    f.companion.need = true;
    await f.service.restore();
    await f.service.retry();
    // The old phone was paired again on the encrypted connection: nothing needs the address.
    f.companion.need = false;
    for (let tick = 0; tick < 3; tick += 1) {
      f.clock.now += HOUR_MS;
      await f.watchdog();
    }
    expect(client.ensureEndpoint).toHaveBeenCalledTimes(1);
    f.service.dispose();

    const plain = readyClient({ ensureEndpoint: vi.fn(async () => Promise.reject(new ControlPlaneError("relay_capable", 409))) });
    const g = onDemandFixture({ client: plain, relay: { capable: () => true, legacyDevices: async () => 1 } });
    g.companion.need = true;
    await g.service.restore();
    await expect(g.service.retry()).resolves.toEqual({ available: true, status: "ready", email: "ada@example.com" });
    expect(g.store.read()).not.toHaveProperty(COMPANION_TUNNEL_WAITING_FIELD);
    expect(g.store.read()).not.toHaveProperty(COMPANION_TUNNEL_RETIRED_FIELD);
    for (let tick = 0; tick < 3; tick += 1) {
      g.clock.now += HOUR_MS;
      await g.watchdog();
    }
    expect(plain.ensureEndpoint).toHaveBeenCalledTimes(1);
    g.service.dispose();
  });

  it("tells a desktop below the minimum version to update", async () => {
    const message = friendlyCompanionAccountError(new ControlPlaneError("update_required", 426));
    expect(message).toBe("This version of MausBot can no longer make secure links. Update MausBot, then try again. Local Wi-Fi and Tailscale pairing still work.");
  });

  it("signs a relay-capable computer in without a tunnel when no phone needs one", async () => {
    for (const relayCapable of [true, false]) {
      const f = onDemandFixture({ initial: {}, relay: { capable: () => relayCapable, legacyDevices: async () => 0 } });
      f.companion.need = false;
      await f.service.requestCode("ada@example.com");
      const state = await f.service.verifyCode("ada@example.com", "12345678");
      expect(f.client.ensureInstallation).toHaveBeenCalledOnce();
      if (relayCapable) {
        expect(f.client.ensureEndpoint).not.toHaveBeenCalled();
        expect(state).toEqual({ available: true, status: "ready", email: "ada@example.com" });
      } else {
        expect(f.client.ensureEndpoint).toHaveBeenCalledOnce();
      }
      f.service.dispose();
    }
  });

  it("never asks for an address at launch or on the watchdog, whatever is paired", async () => {
    for (const need of [false, true, null]) {
      const f = onDemandFixture({
        initial: signedInWithoutAddress(),
        client: readyClient({ getEndpoint: vi.fn(async () => null) }),
      });
      f.companion.need = need;

      await expect(f.service.restore()).resolves.toEqual({
        available: true,
        status: "ready",
        email: "ada@example.com",
      });
      for (let tick = 0; tick < 3; tick += 1) {
        f.clock.now += HOUR_MS;
        await f.watchdog();
      }

      for (const call of ["ensureInstallation", "ensureEndpoint", "getEndpoint", "deleteEndpoint"]) {
        expect(f.client[call]).not.toHaveBeenCalled();
      }
      expect(f.store.writes).toHaveLength(0);
      await expect(f.service.state()).resolves.toEqual({
        available: true,
        status: "ready",
        email: "ada@example.com",
      });
      f.service.dispose();
    }
  });

  it("gives an address nothing needs back one to four hours later, connector first", async () => {
    for (const [random, delay] of [[0, HOUR_MS], [0.5, 2.5 * HOUR_MS], [1, 4 * HOUR_MS]]) {
      const f = onDemandFixture({ random: () => random });

      await f.service.restore();
      expect(f.store.writes).toHaveLength(1);
      const releaseAt = f.store.read()[MANAGED_COMPANION_RELEASE_AT_FIELD];
      expect(releaseAt).toBe(LAUNCH_AT + delay);

      while (f.clock.now + 15 * 60_000 < releaseAt) {
        f.clock.now += 15 * 60_000;
        await f.watchdog();
      }
      expect(f.stopManagedEndpoint).not.toHaveBeenCalled();
      expect(f.client.deleteEndpoint).not.toHaveBeenCalled();
      expect(f.store.writes).toHaveLength(1);

      f.clock.now = releaseAt;
      await f.watchdog();
      expect(f.client.deleteEndpoint).toHaveBeenCalledOnce();
      expect(f.client.deleteEndpoint).toHaveBeenCalledWith(INSTALLATION_CREDENTIAL);
      expect(f.stopManagedEndpoint.mock.invocationCallOrder[0])
        .toBeLessThan(f.client.deleteEndpoint.mock.invocationCallOrder[0]);
      for (const field of ADDRESS_FIELDS) expect(f.store.read()).not.toHaveProperty(field);
      expect(f.store.read()).toMatchObject({
        [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
        [COMPANION_INSTALLATION_ID_FIELD]: INSTALLATION_ID,
        [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: INSTALLATION_CREDENTIAL,
      });
      expect(f.activatePersistedEndpoint).not.toHaveBeenCalled();
      await expect(f.service.state()).resolves.toEqual({
        available: true,
        status: "ready",
        email: "ada@example.com",
      });

      f.clock.now += 10 * HOUR_MS;
      await f.watchdog();
      expect(f.client.deleteEndpoint).toHaveBeenCalledOnce();
      expect(f.client.ensureEndpoint).not.toHaveBeenCalled();

      expect(f.lines()).toEqual([
        `companion account: no device needs the secure address; giving it back in ${delay / 60_000} min`,
        "companion account: gave the secure address back; no device needs it",
      ]);
      for (const secret of [ACCOUNT_TOKEN, CONNECTOR_TOKEN, INSTALLATION_ID, INSTALLATION_CREDENTIAL, ENDPOINT, "ada@example.com"]) {
        expect(f.lines().join("\n")).not.toContain(secret);
      }
      f.service.dispose();
    }
  });

  it("never gives the address back, or writes, while the need cannot be told", async () => {
    for (const on of [false, true]) {
      const initial = signedCredentials({ [MANAGED_COMPANION_RELEASE_AT_FIELD]: LAUNCH_AT - HOUR_MS });
      const f = onDemandFixture({
        initial,
        client: readyClient({ getEndpoint: vi.fn(async () => ({ url: ENDPOINT, status: "ready" })) }),
      });
      f.companion.on = on;
      f.companion.need = null;

      await f.service.restore();
      for (let tick = 0; tick < 4; tick += 1) {
        f.clock.now += 2 * HOUR_MS;
        await f.watchdog();
      }

      expect(f.stopManagedEndpoint).not.toHaveBeenCalled();
      expect(f.client.deleteEndpoint).not.toHaveBeenCalled();
      expect(f.client.ensureEndpoint).not.toHaveBeenCalled();
      expect(f.store.read()).toEqual(initial);
      expect(f.store.writes).toHaveLength(0);
      expect(f.client.getEndpoint).toHaveBeenCalledTimes(on ? 4 : 0);
      f.service.dispose();
    }
  });

  it("keeps a needed address, cancels a planned release, and recovers it behind the same address", async () => {
    const getEndpoint = vi.fn(async () => ({ url: ENDPOINT, status: "ready" }));
    const ensureEndpoint = vi.fn(async () => ({
      endpoint: { url: ENDPOINT },
      connectorToken: RECLAIMED_TOKEN,
    }));
    const f = onDemandFixture({
      initial: signedCredentials({ [MANAGED_COMPANION_RELEASE_AT_FIELD]: LAUNCH_AT + HOUR_MS }),
      client: readyClient({ getEndpoint, ensureEndpoint }),
    });
    f.companion.need = true;

    await f.service.restore();
    expect(f.store.read()).not.toHaveProperty(MANAGED_COMPANION_RELEASE_AT_FIELD);
    expect(f.store.writes).toHaveLength(1);

    f.clock.now += 2 * HOUR_MS;
    getEndpoint.mockResolvedValue(null);
    f.companion.connection = { status: "retrying", ready: false };
    await f.watchdog();
    expect(ensureEndpoint).toHaveBeenCalledOnce();
    expect(f.store.read()).toMatchObject({
      [MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
      [MANAGED_COMPANION_TOKEN_FIELD]: RECLAIMED_TOKEN,
    });
    expect(f.activatePersistedEndpoint).toHaveBeenCalledOnce();
    expect(f.client.verifyOTP).not.toHaveBeenCalled();

    f.companion.connection = { status: "ready", ready: true };
    getEndpoint.mockResolvedValue({ url: ENDPOINT, status: "ready" });
    for (let tick = 0; tick < 4; tick += 1) {
      f.clock.now += 24 * HOUR_MS;
      await f.watchdog();
    }
    expect(f.stopManagedEndpoint).not.toHaveBeenCalled();
    expect(f.client.deleteEndpoint).not.toHaveBeenCalled();
    expect(f.store.read()).not.toHaveProperty(MANAGED_COMPANION_RELEASE_AT_FIELD);
    expect(f.store.read()[MANAGED_COMPANION_ENDPOINT_FIELD]).toBe(ENDPOINT);
    f.service.dispose();
  });

  it("does not give the address back when a pairing opens between the check and the release", async () => {
    const answers = [false, true];
    const f = onDemandFixture({
      initial: signedCredentials({ [MANAGED_COMPANION_RELEASE_AT_FIELD]: LAUNCH_AT - 1 }),
      managedEndpointNeeded: vi.fn(async () => answers.shift() ?? true),
    });

    await f.service.restore();

    expect(f.stopManagedEndpoint).not.toHaveBeenCalled();
    expect(f.client.deleteEndpoint).not.toHaveBeenCalled();
    expect(f.store.read()[MANAGED_COMPANION_ENDPOINT_FIELD]).toBe(ENDPOINT);
    expect(f.store.read()).not.toHaveProperty(MANAGED_COMPANION_RELEASE_AT_FIELD);
    f.service.dispose();
  });

  it("gives back at once an unneeded address whose tunnel is gone, instead of repairing it", async () => {
    for (const serverView of [null, { url: ENDPOINT, status: "error" }]) {
      const f = onDemandFixture({ client: readyClient({ getEndpoint: vi.fn(async () => serverView) }) });
      f.companion.connection = { status: "retrying", ready: false };

      await f.service.restore();

      expect(f.client.getEndpoint).toHaveBeenCalledOnce();
      expect(f.client.ensureEndpoint).not.toHaveBeenCalled();
      expect(f.client.deleteEndpoint).toHaveBeenCalledOnce();
      for (const field of ADDRESS_FIELDS) expect(f.store.read()).not.toHaveProperty(field);
      f.service.dispose();
    }
  });

  it("keeps the address when the DELETE fails, and forgets it once the control plane has it", async () => {
    const due = { [MANAGED_COMPANION_RELEASE_AT_FIELD]: LAUNCH_AT - 1 };
    for (const error of [
      new ControlPlaneError("network_unavailable"),
      new ControlPlaneError("control_plane_unavailable", 502),
      new ControlPlaneError("endpoint_busy", 409, "", 2_000),
      new ControlPlaneError("rate_limited", 429),
    ]) {
      const deleteEndpoint = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
      const f = onDemandFixture({ initial: signedCredentials(due), client: readyClient({ deleteEndpoint }) });

      await f.service.restore();
      expect(deleteEndpoint).toHaveBeenCalledOnce();
      expect(f.store.read()).toMatchObject({
        [MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
        [MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
      });
      expect(f.activatePersistedEndpoint).toHaveBeenCalledOnce();
      expect(f.stopManagedEndpoint.mock.invocationCallOrder[0])
        .toBeLessThan(f.activatePersistedEndpoint.mock.invocationCallOrder[0]);
      expect(f.lines()).toContain(
        `companion account: could not give the secure address back code=${error.code} status=${error.status || "none"} ref=none`,
      );

      f.clock.now += 15 * 60_000;
      await f.watchdog();
      expect(deleteEndpoint).toHaveBeenCalledTimes(2);
      for (const field of ADDRESS_FIELDS) expect(f.store.read()).not.toHaveProperty(field);
      f.service.dispose();
    }
    for (const [error, pending] of [
      [new ControlPlaneError("endpoint_cleanup_pending", 503), true],
      [new ControlPlaneError("unauthorized", 401), false],
    ]) {
      const f = onDemandFixture({
        initial: signedCredentials(due),
        client: readyClient({ deleteEndpoint: vi.fn(async () => { throw error; }) }),
      });

      await f.service.restore();

      for (const field of ADDRESS_FIELDS) expect(f.store.read()).not.toHaveProperty(field);
      expect(f.store.read()[COMPANION_ENDPOINT_RELEASE_PENDING_FIELD]).toBe(pending ? true : undefined);
      expect(f.activatePersistedEndpoint).not.toHaveBeenCalled();
      f.service.dispose();
    }
  });

  it("prepare() creates, starts or repairs the address a pairing will offer, and only then", async () => {
    const network = ["health", "ensureInstallation", "ensureEndpoint", "getEndpoint", "deleteEndpoint"];

    const fresh = onDemandFixture({ initial: signedInWithoutAddress() });
    await expect(fresh.service.prepare()).resolves.toEqual({
      available: true,
      status: "ready",
      email: "ada@example.com",
      endpoint: ENDPOINT,
    });
    expect(fresh.client.ensureEndpoint).toHaveBeenCalledOnce();
    expect(fresh.activatePersistedEndpoint).toHaveBeenCalledOnce();
    expect(fresh.client.verifyOTP).not.toHaveBeenCalled();

    const ready = onDemandFixture({
      initial: signedCredentials({ [MANAGED_COMPANION_RELEASE_AT_FIELD]: LAUNCH_AT + HOUR_MS }),
      client: readyClient({ getEndpoint: vi.fn(async () => null) }),
    });
    await ready.service.state();
    ready.client.health.mockClear();
    await expect(ready.service.prepare()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });
    for (const call of network) expect(ready.client[call]).not.toHaveBeenCalled();
    expect(ready.activatePersistedEndpoint).not.toHaveBeenCalled();
    expect(ready.store.read()).not.toHaveProperty(MANAGED_COMPANION_RELEASE_AT_FIELD);

    const broken = onDemandFixture({
      client: readyClient({
        getEndpoint: vi.fn(async () => null),
        ensureEndpoint: vi.fn(async () => ({ endpoint: { url: ENDPOINT }, connectorToken: RECLAIMED_TOKEN })),
      }),
    });
    broken.companion.connection = { status: "retrying", ready: false };
    await broken.service.prepare();
    expect(broken.client.getEndpoint).toHaveBeenCalledOnce();
    expect(broken.client.ensureEndpoint).toHaveBeenCalledOnce();
    expect(broken.store.read()).toMatchObject({
      [MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
      [MANAGED_COMPANION_TOKEN_FIELD]: RECLAIMED_TOKEN,
    });

    const stopped = onDemandFixture({ client: readyClient({ getEndpoint: vi.fn(async () => null) }) });
    stopped.companion.connection = { status: "stopped", ready: false };
    await stopped.service.prepare();
    expect(stopped.activatePersistedEndpoint).toHaveBeenCalledOnce();
    for (const call of network) expect(stopped.client[call]).not.toHaveBeenCalled();

    for (const [initial, on] of [
      [signedInWithoutAddress(), false],
      [{ [COMPANION_CLIENT_INSTANCE_FIELD]: UUID }, true],
    ]) {
      const idle = onDemandFixture({ initial, client: readyClient({ getEndpoint: vi.fn(async () => null) }) });
      idle.companion.on = on;
      await idle.service.prepare();
      for (const call of network) expect(idle.client[call]).not.toHaveBeenCalled();
      expect(idle.activatePersistedEndpoint).not.toHaveBeenCalled();
      expect(idle.store.writes).toHaveLength(0);
    }
  });

  it("counts a paired phone as in use until 30 days after it was last seen, and an unknown time as in use", () => {
    const DAY_MS = 24 * HOUR_MS;
    const now = LAUNCH_AT;
    const phone = (lastSeenAt, id = "phone-1") => ({ id, name: "Ada", lastSeenAt });
    const answer = (devices, overrides) => ({ enabled: true, devices, pairing: null, ...overrides });
    expect(PHONE_UNUSED_RELEASE_MS).toBe(30 * DAY_MS);

    expect(managedEndpointNeed(answer([phone(now - DAY_MS)]), now)).toBe(true);
    expect(managedEndpointNeed(answer([phone(now - PHONE_UNUSED_RELEASE_MS + 1)]), now)).toBe(true);
    expect(managedEndpointNeed(answer([phone(now - PHONE_UNUSED_RELEASE_MS)]), now)).toBe(true);
    expect(managedEndpointNeed(answer([phone(now - PHONE_UNUSED_RELEASE_MS - 1)]), now)).toBe("unused");
    expect(managedEndpointNeed(answer([phone(now - 400 * DAY_MS)]), now)).toBe("unused");

    const old = phone(now - 90 * DAY_MS);
    expect(managedEndpointNeed(answer([old, phone(now - DAY_MS, "phone-2")]), now)).toBe(true);
    expect(managedEndpointNeed(answer([old], { connectedDeviceIds: ["phone-1"] }), now)).toBe(true);
    expect(managedEndpointNeed(answer([old], { connectedDeviceIds: ["phone-2"] }), now)).toBe("unused");
    const pairing = { code: "123456", token: `omb_pair_${"a".repeat(43)}`, expiresAt: now };
    expect(managedEndpointNeed(answer([old], { pairing }), now)).toBe(true);
    expect(managedEndpointNeed(answer([]), now)).toBe(false);
    for (const unknown of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, String(now - 90 * DAY_MS), now + DAY_MS]) {
      expect(managedEndpointNeed(answer([phone(unknown)]), now), String(unknown)).toBe(true);
    }
    for (const unclear of [answer([old], { devicesUnreadable: true }), answer([old], { error: "down" })]) {
      expect(managedEndpointNeed(unclear, now)).toBeNull();
    }
  });

  it("holds the address while a phone was seen in the last 30 days, then gives it back paused", async () => {
    const seenAt = LAUNCH_AT - PHONE_UNUSED_RELEASE_MS + 3 * HOUR_MS;
    const companionState = { enabled: true, devices: [{ id: "phone-1", name: "Ada", lastSeenAt: seenAt }], pairing: null };
    const clock = { now: LAUNCH_AT };
    const f = onDemandFixture({
      managedEndpointNeeded: vi.fn(async () => managedEndpointNeed(companionState, clock.now)),
      now: () => clock.now,
    });

    await f.service.restore();
    while (clock.now < seenAt + PHONE_UNUSED_RELEASE_MS) {
      clock.now += 15 * 60_000;
      await f.watchdog();
      expect(f.store.read(), new Date(clock.now).toISOString()).not.toHaveProperty(MANAGED_COMPANION_RELEASE_AT_FIELD);
    }
    expect(clock.now).toBe(seenAt + PHONE_UNUSED_RELEASE_MS);
    expect(f.store.writes).toHaveLength(0);

    clock.now += 15 * 60_000;
    await f.watchdog();
    const releaseAt = f.store.read()[MANAGED_COMPANION_RELEASE_AT_FIELD];
    expect(releaseAt).toBe(clock.now + 2.5 * HOUR_MS);
    while (clock.now < releaseAt) {
      expect(f.client.deleteEndpoint).not.toHaveBeenCalled();
      clock.now += 15 * 60_000;
      await f.watchdog();
    }
    expect(f.client.deleteEndpoint).toHaveBeenCalledOnce();
    for (const field of ADDRESS_FIELDS) expect(f.store.read()).not.toHaveProperty(field);
    expect(f.store.read()[COMPANION_ENDPOINT_PAUSED_FIELD]).toBe(true);
    expect(f.lines()).toContain("companion account: gave the secure address back; no paired phone was used in 30 days");
    f.service.dispose();
  });

  it("keeps a paused address down until prepare(), which brings the same address back and clears the pause", async () => {
    const ensureEndpoint = vi.fn(async () => ({ endpoint: { url: ENDPOINT }, connectorToken: RECLAIMED_TOKEN }));
    const f = onDemandFixture({
      initial: signedCredentials({ [MANAGED_COMPANION_RELEASE_AT_FIELD]: LAUNCH_AT - 1 }),
      client: readyClient({ ensureEndpoint }),
    });
    f.companion.need = "unused";

    await f.service.restore();
    expect(f.client.deleteEndpoint).toHaveBeenCalledOnce();
    expect(f.store.read()[COMPANION_ENDPOINT_PAUSED_FIELD]).toBe(true);
    await expect(f.service.state()).resolves.toEqual({
      available: true,
      status: "ready",
      email: "ada@example.com",
      paused: true,
    });

    // Neither time nor a phone seen again on Wi-Fi brings it back without the page.
    for (const need of ["unused", true, null, false]) {
      f.companion.need = need;
      f.clock.now += 10 * HOUR_MS;
      await f.watchdog();
    }
    expect(ensureEndpoint).not.toHaveBeenCalled();
    expect(f.client.deleteEndpoint).toHaveBeenCalledOnce();

    f.companion.need = "unused";
    await expect(f.service.prepare()).resolves.toEqual({
      available: true,
      status: "ready",
      email: "ada@example.com",
      endpoint: ENDPOINT,
    });
    expect(ensureEndpoint).toHaveBeenCalledOnce();
    expect(f.store.read()).toMatchObject({
      [MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
      [MANAGED_COMPANION_TOKEN_FIELD]: RECLAIMED_TOKEN,
    });
    expect(f.store.read()).not.toHaveProperty(COMPANION_ENDPOINT_PAUSED_FIELD);
    expect(f.activatePersistedEndpoint).toHaveBeenCalled();

    // Signing out forgets a pause along with the account.
    const paused = onDemandFixture({ initial: { ...signedInWithoutAddress(), [COMPANION_ENDPOINT_PAUSED_FIELD]: true } });
    await expect(paused.service.state()).resolves.toMatchObject({ paused: true });
    await paused.service.signOut();
    expect(paused.store.read()).not.toHaveProperty(COMPANION_ENDPOINT_PAUSED_FIELD);
    f.service.dispose();
    paused.service.dispose();
  });

  it("gives an address back unpaused when nothing is paired, and never pauses on a can't-tell", async () => {
    for (const need of [false, null]) {
      const f = onDemandFixture({ initial: signedCredentials({ [MANAGED_COMPANION_RELEASE_AT_FIELD]: LAUNCH_AT - 1 }) });
      f.companion.need = need;
      await f.service.restore();
      expect(f.client.deleteEndpoint).toHaveBeenCalledTimes(need === false ? 1 : 0);
      expect(f.store.read()).not.toHaveProperty(COMPANION_ENDPOINT_PAUSED_FIELD);
      expect(await f.service.state()).not.toHaveProperty("paused");
      f.service.dispose();
    }
  });

  it("says when to try again when HTTPS links are full, retries for the hour, then lets it go", async () => {
    const ensureEndpoint = vi.fn(async () => {
      throw new ControlPlaneError("endpoint_capacity", 503, "", 600_000);
    });
    const f = onDemandFixture({ initial: signedInWithoutAddress(), client: readyClient({ ensureEndpoint }) });

    await expect(f.service.prepare()).resolves.toMatchObject({
      status: "error",
      message: "Secure HTTPS links are temporarily full. Try again in 10 minutes, or pair on this Wi-Fi or with Tailscale.",
    });
    expect(f.retries()).toEqual([600_000]);

    f.clock.now += 10 * 60_000;
    await f.retryTimer();
    expect(ensureEndpoint).toHaveBeenCalledTimes(2);
    expect(f.retries()).toEqual([20 * 60_000]);

    f.clock.now += HOUR_MS;
    await f.retryTimer();
    expect(ensureEndpoint).toHaveBeenCalledTimes(2);
    expect(f.retries()).toEqual([]);
    await expect(f.service.state()).resolves.toEqual({
      available: true,
      status: "ready",
      email: "ada@example.com",
    });
    expect(f.lines()).toContain("companion account: stopped retrying; no device needs a secure address");
    f.service.dispose();
  });

  it("keeps repairing a needed address after the hour, but never makes one for a paired device alone", async () => {
    const capacity = new ControlPlaneError("endpoint_capacity", 503, "", 600_000);
    const kept = onDemandFixture({
      client: readyClient({
        getEndpoint: vi.fn(async () => null),
        ensureEndpoint: vi.fn(async () => { throw capacity; }),
      }),
    });
    kept.companion.need = true;
    kept.companion.connection = { status: "retrying", ready: false };
    await kept.service.restore();
    expect(kept.client.ensureEndpoint).toHaveBeenCalledOnce();
    kept.clock.now += 3 * HOUR_MS;
    await kept.retryTimer();
    expect(kept.client.ensureEndpoint).toHaveBeenCalledTimes(2);
    expect(kept.store.read()[MANAGED_COMPANION_TOKEN_FIELD]).toBe(CONNECTOR_TOKEN);
    kept.service.dispose();

    const wifi = onDemandFixture({
      initial: signedInWithoutAddress(),
      client: readyClient({ ensureEndpoint: vi.fn(async () => { throw capacity; }) }),
    });
    await wifi.service.prepare();
    wifi.companion.need = true;
    wifi.clock.now += 2 * HOUR_MS;
    await wifi.retryTimer();
    expect(wifi.client.ensureEndpoint).toHaveBeenCalledOnce();
    expect(wifi.retries()).toEqual([]);
    wifi.service.dispose();
  });

  it("keeps the address a sign-in made for an hour, then gives it back if nothing paired", async () => {
    const f = onDemandFixture({ initial: { [COMPANION_CLIENT_INSTANCE_FIELD]: UUID } });
    await f.service.restore();
    await expect(f.service.verifyCode("ada@example.com", "12345678")).resolves.toMatchObject({
      status: "ready",
      endpoint: ENDPOINT,
    });

    f.clock.now += 45 * 60_000;
    await f.watchdog();
    expect(f.store.read()).not.toHaveProperty(MANAGED_COMPANION_RELEASE_AT_FIELD);

    f.clock.now += 30 * 60_000;
    await f.watchdog();
    const releaseAt = f.store.read()[MANAGED_COMPANION_RELEASE_AT_FIELD];
    expect(releaseAt).toBe(f.clock.now + 2.5 * HOUR_MS);

    f.clock.now = releaseAt;
    await f.watchdog();
    expect(f.client.deleteEndpoint).toHaveBeenCalledOnce();
    for (const field of ADDRESS_FIELDS) expect(f.store.read()).not.toHaveProperty(field);
    f.service.dispose();
  });

  it("loses nothing while the control plane cannot be reached", async () => {
    const offline = async () => {
      throw new ControlPlaneError("network_unavailable");
    };
    const pairing = onDemandFixture({
      initial: signedInWithoutAddress(),
      client: readyClient({ health: vi.fn(offline) }),
    });
    await expect(pairing.service.prepare()).resolves.toMatchObject({
      status: "error",
      message: "Secure access is not available right now. Local pairing still works.",
    });
    expect(pairing.client.ensureEndpoint).not.toHaveBeenCalled();
    expect(pairing.retries()).toHaveLength(1);
    pairing.clock.now += 2 * HOUR_MS;
    await pairing.retryTimer();
    expect(pairing.client.health).toHaveBeenCalledOnce();
    expect(pairing.retries()).toEqual([]);
    pairing.service.dispose();

    const initial = signedCredentials({ [MANAGED_COMPANION_RELEASE_AT_FIELD]: LAUNCH_AT - 1 });
    const saved = onDemandFixture({
      initial,
      client: readyClient({ health: vi.fn(offline), getEndpoint: vi.fn(offline), deleteEndpoint: vi.fn(offline) }),
    });
    saved.companion.need = true;
    saved.companion.connection = { status: "retrying", ready: false };
    await saved.service.restore();
    await saved.watchdog();
    expect(saved.client.getEndpoint).toHaveBeenCalledOnce();
    expect(saved.client.ensureEndpoint).not.toHaveBeenCalled();
    expect(saved.store.read()[MANAGED_COMPANION_ENDPOINT_FIELD]).toBe(ENDPOINT);

    saved.companion.need = false;
    saved.clock.now += HOUR_MS;
    await saved.watchdog();
    saved.clock.now = saved.store.read()[MANAGED_COMPANION_RELEASE_AT_FIELD];
    await saved.watchdog();
    expect(saved.client.deleteEndpoint).toHaveBeenCalledOnce();
    expect(saved.activatePersistedEndpoint).toHaveBeenCalledOnce();
    expect(saved.store.read()).toMatchObject({
      [MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
      [MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
    });
    saved.service.dispose();
  });

  it("plans the release again when a clock jump put it more than four hours away", async () => {
    const f = onDemandFixture({
      initial: signedCredentials({ [MANAGED_COMPANION_RELEASE_AT_FIELD]: LAUNCH_AT + 30 * 24 * HOUR_MS }),
    });
    await f.service.restore();
    expect(f.store.read()[MANAGED_COMPANION_RELEASE_AT_FIELD]).toBe(LAUNCH_AT + 2.5 * HOUR_MS);
    f.service.dispose();
  });

  it("leaves can't tell at launch to the first check, so nothing re-creates a tunnel nobody needs", async () => {
    for (const need of [false, true]) {
      const f = onDemandFixture({
        client: readyClient({
          getEndpoint: vi.fn(async () => null),
          ensureEndpoint: vi.fn(async () => ({ endpoint: { url: ENDPOINT }, connectorToken: RECLAIMED_TOKEN })),
        }),
      });
      f.companion.need = null;
      f.companion.connection = { status: "starting", ready: false };

      await expect(f.service.restore()).resolves.toMatchObject({ status: "connecting", endpoint: ENDPOINT });
      for (const call of ["getEndpoint", "ensureEndpoint", "deleteEndpoint"]) {
        expect(f.client[call]).not.toHaveBeenCalled();
      }
      expect(f.store.writes).toHaveLength(0);

      f.companion.need = need;
      f.companion.connection = { status: "retrying", ready: false };
      f.clock.now += 2 * 60_000;
      await f.watchdog();
      expect(f.client.getEndpoint).toHaveBeenCalledOnce();
      if (need) {
        expect(f.client.ensureEndpoint).toHaveBeenCalledOnce();
        expect(f.client.deleteEndpoint).not.toHaveBeenCalled();
        expect(f.store.read()[MANAGED_COMPANION_TOKEN_FIELD]).toBe(RECLAIMED_TOKEN);
      } else {
        expect(f.client.ensureEndpoint).not.toHaveBeenCalled();
        expect(f.client.deleteEndpoint).toHaveBeenCalledOnce();
        for (const field of ADDRESS_FIELDS) expect(f.store.read()).not.toHaveProperty(field);
      }
      f.service.dispose();
    }
  });

  it("finishes a removal the control plane left pending before asking for the address again", async () => {
    const pending = new ControlPlaneError("endpoint_cleanup_pending", 503);
    const deleteEndpoint = vi.fn()
      .mockRejectedValueOnce(pending)
      .mockRejectedValueOnce(pending)
      .mockResolvedValue(undefined);
    const ensureEndpoint = vi.fn()
      .mockRejectedValueOnce(new ControlPlaneError("endpoint_busy", 409, "", 2_000))
      .mockResolvedValue({ endpoint: { url: ENDPOINT }, connectorToken: RECLAIMED_TOKEN });
    const f = onDemandFixture({
      initial: signedCredentials({ [MANAGED_COMPANION_RELEASE_AT_FIELD]: LAUNCH_AT - 1 }),
      client: readyClient({ deleteEndpoint, ensureEndpoint }),
    });

    await f.service.restore();
    expect(deleteEndpoint).toHaveBeenCalledOnce();
    expect(f.store.read()[COMPANION_ENDPOINT_RELEASE_PENDING_FIELD]).toBe(true);

    await expect(f.service.prepare()).resolves.toMatchObject({
      status: "error",
      message: "The secure connection is still being prepared. Try again in a moment.",
    });
    expect(deleteEndpoint).toHaveBeenCalledTimes(2);
    expect(deleteEndpoint.mock.invocationCallOrder[1]).toBeLessThan(ensureEndpoint.mock.invocationCallOrder[0]);
    expect(f.store.read()[COMPANION_ENDPOINT_RELEASE_PENDING_FIELD]).toBe(true);
    expect(f.retries()).toHaveLength(1);

    f.clock.now += 10 * 60_000;
    await f.retryTimer();
    expect(deleteEndpoint).toHaveBeenCalledTimes(3);
    expect(deleteEndpoint.mock.invocationCallOrder[2]).toBeLessThan(ensureEndpoint.mock.invocationCallOrder[1]);
    expect(ensureEndpoint).toHaveBeenCalledTimes(2);
    expect(f.store.read()).toMatchObject({
      [MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
      [MANAGED_COMPANION_TOKEN_FIELD]: RECLAIMED_TOKEN,
    });
    expect(f.store.read()).not.toHaveProperty(COMPANION_ENDPOINT_RELEASE_PENDING_FIELD);
    await expect(f.service.state()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });

    await f.service.retry();
    expect(deleteEndpoint).toHaveBeenCalledTimes(3);
    f.service.dispose();

    const full = onDemandFixture({
      initial: { ...signedInWithoutAddress(), [COMPANION_ENDPOINT_RELEASE_PENDING_FIELD]: true },
      client: readyClient({
        ensureEndpoint: vi.fn(async () => { throw new ControlPlaneError("endpoint_capacity", 503, "", 600_000); }),
      }),
    });
    await expect(full.service.prepare()).resolves.toMatchObject({ status: "error" });
    expect(full.client.deleteEndpoint).toHaveBeenCalledOnce();
    expect(full.store.read()).not.toHaveProperty(COMPANION_ENDPOINT_RELEASE_PENDING_FIELD);
    full.clock.now += 10 * 60_000;
    await full.retryTimer();
    expect(full.client.ensureEndpoint).toHaveBeenCalledTimes(2);
    expect(full.client.deleteEndpoint).toHaveBeenCalledOnce();
    full.service.dispose();

    const rejected = onDemandFixture({
      initial: { ...signedInWithoutAddress(), [COMPANION_ENDPOINT_RELEASE_PENDING_FIELD]: true },
      client: readyClient({ deleteEndpoint: vi.fn(async () => { throw new ControlPlaneError("unauthorized", 401); }) }),
    });
    await expect(rejected.service.prepare()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });
    expect(rejected.client.deleteEndpoint).toHaveBeenCalledOnce();
    expect(rejected.client.ensureEndpoint).toHaveBeenCalledOnce();
    expect(rejected.store.read()).not.toHaveProperty(COMPANION_ENDPOINT_RELEASE_PENDING_FIELD);
    rejected.service.dispose();

    const out = onDemandFixture({
      initial: signedCredentials({ [COMPANION_ENDPOINT_RELEASE_PENDING_FIELD]: true }),
    });
    await out.service.signOut();
    expect(out.store.read()).not.toHaveProperty(COMPANION_ENDPOINT_RELEASE_PENDING_FIELD);
    out.service.dispose();
  });

  it("reconciles an address an older release saved once a device needs it", async () => {
    const outdated = signedCredentials({ [MANAGED_COMPANION_ORIGIN_VERSION_FIELD]: MANAGED_COMPANION_ORIGIN_VERSION - 1 });
    const provisioned = () => vi.fn(async () => ({ endpoint: { url: ENDPOINT }, connectorToken: RECLAIMED_TOKEN }));

    const ensureEndpoint = vi.fn()
      .mockRejectedValueOnce(new ControlPlaneError("endpoint_capacity", 503, "", 600_000))
      .mockResolvedValue({ endpoint: { url: ENDPOINT }, connectorToken: RECLAIMED_TOKEN });
    const idle = onDemandFixture({ initial: outdated, client: readyClient({ ensureEndpoint }) });
    idle.companion.need = null;
    await idle.service.restore();
    idle.companion.need = false;
    for (let tick = 0; tick < 3; tick += 1) {
      idle.clock.now += HOUR_MS;
      await idle.watchdog();
    }
    expect(ensureEndpoint).not.toHaveBeenCalled();
    expect(idle.store.writes).toHaveLength(0);

    idle.companion.need = true;
    idle.clock.now += HOUR_MS;
    await idle.watchdog();
    expect(ensureEndpoint).toHaveBeenCalledOnce();
    expect(idle.retries()).toEqual([600_000]);
    idle.clock.now += 5 * 60_000;
    await idle.watchdog();
    expect(ensureEndpoint).toHaveBeenCalledOnce();
    idle.clock.now += 5 * 60_000;
    await idle.retryTimer();
    expect(ensureEndpoint).toHaveBeenCalledTimes(2);
    expect(idle.store.read()).toMatchObject({
      [MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
      [MANAGED_COMPANION_TOKEN_FIELD]: RECLAIMED_TOKEN,
      [MANAGED_COMPANION_ORIGIN_VERSION_FIELD]: MANAGED_COMPANION_ORIGIN_VERSION,
    });
    expect(idle.activatePersistedEndpoint).toHaveBeenCalledOnce();
    idle.service.dispose();

    const paired = onDemandFixture({ initial: outdated, client: readyClient({ ensureEndpoint: provisioned() }) });
    paired.companion.need = true;
    await expect(paired.service.restore()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });
    expect(paired.client.ensureEndpoint).toHaveBeenCalledOnce();
    paired.service.dispose();
  });
});
