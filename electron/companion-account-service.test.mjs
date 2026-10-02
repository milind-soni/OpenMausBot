import { describe, expect, it, vi } from "vitest";

import { ControlPlaneError } from "./control-plane-client.mjs";
import {
  COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD,
  COMPANION_ACCOUNT_EMAIL_FIELD,
  COMPANION_ACCOUNT_TOKEN_FIELD,
  COMPANION_ACCOUNT_USER_ID_FIELD,
  COMPANION_CLIENT_INSTANCE_FIELD,
  COMPANION_INSTALLATION_CREDENTIAL_FIELD,
  COMPANION_INSTALLATION_EXPIRY_FIELD,
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
    // First save the account identity, then the installation needed to retry.
    // Endpoint and connector material still become durable together.
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
    expect(ensureEndpoint).toHaveBeenNthCalledWith(2, INSTALLATION_CREDENTIAL);
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

/** Captures scheduled callbacks so a test decides when time passes. */
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
      message: "Secure HTTPS links are temporarily full. Pair on this Wi-Fi or with Tailscale for now; we'll retry automatically.",
    });
    // The server's ten-minute hint outranks the first one-second backoff.
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

    // Remote access is switched on and the saved token's tunnel is gone.
    on = true;
    connection = { status: "retrying", ready: false };
    timers.fire();
    await vi.waitFor(() => expect(client.ensureEndpoint).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(store.read()[MANAGED_COMPANION_TOKEN_FIELD]).toBe(RECLAIMED_TOKEN));

    // A missing binary, or a check inside the interval, costs nothing.
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
    // The app kept running through the sleep. The connector verified its
    // route once and still says "ready", but the server removed the tunnel
    // (or, after a cancelled reclaim, its DNS record) meanwhile.
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

      // Launch: the endpoint is live, so nothing changes.
      await expect(service.restore()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });
      expect(client.getEndpoint).toHaveBeenCalledOnce();

      // Weeks later the laptop wakes and the next watchdog tick runs.
      clock += 30 * 24 * 60 * 60_000;
      client.getEndpoint.mockResolvedValue(serverView);
      timers.fire();
      await vi.waitFor(() => expect(store.read()[MANAGED_COMPANION_TOKEN_FIELD]).toBe(RECLAIMED_TOKEN));
      expect(client.getEndpoint).toHaveBeenCalledTimes(2);
      expect(client.ensureEndpoint).toHaveBeenCalledOnce();
      expect(client.ensureEndpoint).toHaveBeenCalledWith(INSTALLATION_CREDENTIAL);
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
    // The first tick comes right after the launch check and is skipped.
    clock += 100;
    timers.fire();
    await Promise.resolve();
    expect(client.getEndpoint).toHaveBeenCalledOnce();
    // Ticks then come exactly one interval apart, and each check is recorded
    // a few milliseconds after its own tick, as on a busy event loop.
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

    // Not "starting" forever: the person is told to sign in again.
    await expect(service.restore()).resolves.toMatchObject({
      status: "signed-out",
      email: "ada@example.com",
      message: expect.stringContaining("sign-in expired"),
    });
    expect(client.ensureEndpoint).not.toHaveBeenCalled();
    expect(store.read()).toEqual(initial);

    // Only the person can fix this, so the watchdog stops asking.
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
