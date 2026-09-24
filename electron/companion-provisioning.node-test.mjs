import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { createControlPlaneClient } from "./control-plane-client.mjs";
import {
  COMPANION_ACCOUNT_EMAIL_FIELD,
  COMPANION_ACCOUNT_TOKEN_FIELD,
  COMPANION_ACCOUNT_USER_ID_FIELD,
  COMPANION_CLIENT_INSTANCE_FIELD,
  COMPANION_INSTALLATION_CREDENTIAL_FIELD,
  COMPANION_INSTALLATION_EXPIRY_FIELD,
  COMPANION_INSTALLATION_ID_FIELD,
  createCompanionAccountService,
} from "./companion-account-service.mjs";
import {
  MANAGED_COMPANION_ENDPOINT_FIELD,
  MANAGED_COMPANION_ORIGIN_VERSION,
  MANAGED_COMPANION_ORIGIN_VERSION_FIELD,
  MANAGED_COMPANION_TOKEN_FIELD,
} from "./managed-companion-tunnel.mjs";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_TOKEN = `fixture-account.${"a".repeat(40)}`;
const INSTALLATION_CREDENTIAL = `omb_install_${"b".repeat(22)}.${"c".repeat(43)}`;
const CONNECTOR_TOKEN = `fixture-connector.${"d".repeat(80)}`;
const EMAIL = "companion-fixture@example.test";
const ENDPOINT = "https://c-fixture.example.test";

test("endpoint failure retains the installation across immediate Retry and restart over real HTTP", { timeout: 15_000 }, async () => {
  const identity = { name: "Fixture computer", platform: "darwin", appVersion: "1.2.3" };
  const installation = { id: INSTALLATION_ID, clientInstanceId: CLIENT_ID, ...identity };
  const credentialExpiresAt = Date.now() + 86_400_000;
  const calls = [];
  const routeFailures = [];
  let installationCreated = false;
  let endpointReady = false;
  let baseURL;
  let document = { unrelatedCredential: "keep-fixture-value" };
  let activations = 0;
  let identitiesCreated = 0;

  const reply = (response, status, body, headers = {}) => {
    response.writeHead(status, {
      "content-type": "application/json",
      "x-request-id": REQUEST_ID,
      ...headers,
    });
    response.end(JSON.stringify(body));
  };
  const route = async (request, response) => {
    const key = `${request.method} ${request.url}`;
    calls.push(key);
    assert.equal(request.headers.host, new URL(baseURL).host);
    let rawBody = "";
    for await (const chunk of request) rawBody += chunk;
    const body = rawBody ? JSON.parse(rawBody) : null;
    const expectedBearer = request.url.startsWith("/v1/installations/self")
      ? `Bearer ${INSTALLATION_CREDENTIAL}`
      : request.url.startsWith("/v1/") ? `Bearer ${ACCOUNT_TOKEN}` : undefined;
    assert.equal(request.headers.authorization, expectedBearer, `unexpected bearer for ${key}`);
    assert.equal(request.headers.origin, request.url.startsWith("/api/auth/") ? baseURL : undefined);

    switch (key) {
      case "GET /healthz":
        assert.equal(body, null);
        return reply(response, 200, { ok: true, service: "openmausbot-control-plane" });
      case "POST /api/auth/email-otp/send-verification-otp":
        assert.deepEqual(body, { email: EMAIL, type: "sign-in" });
        return reply(response, 200, { success: true });
      case "POST /api/auth/sign-in/email-otp":
        assert.deepEqual(body, { email: EMAIL, otp: "12345678", name: "companion-fixture" });
        return reply(response, 200, { user: { id: "fixture-user", email: EMAIL } }, {
          "set-auth-token": ACCOUNT_TOKEN,
        });
      case "GET /v1/installations":
        assert.equal(body, null);
        return reply(response, 200, { installations: installationCreated ? [installation] : [] });
      case "POST /v1/installations":
        assert.equal(installationCreated, false, "must not register another installation");
        assert.deepEqual(body, { clientInstanceId: CLIENT_ID, ...identity });
        installationCreated = true;
        return reply(response, 201, { installation, credential: INSTALLATION_CREDENTIAL, credentialExpiresAt });
      case "GET /v1/installations/self":
        assert.equal(body, null);
        assert.equal(installationCreated, true);
        return reply(response, 200, { installation, credentialExpiresAt });
      case `POST /v1/installations/${INSTALLATION_ID}/credentials/rotate`:
        assert.equal(body, null);
        assert.equal(installationCreated, true);
        return reply(response, 429, { error: "credential_rotation_rate_limited" });
      case "POST /v1/installations/self/endpoint":
        assert.equal(body, null);
        assert.equal(installationCreated, true);
        return endpointReady
          ? reply(response, 200, { endpoint: { url: ENDPOINT }, connectorToken: CONNECTOR_TOKEN })
          : reply(response, 502, { error: "endpoint_unavailable" });
      default:
        assert.fail(`unexpected fixture request: ${key}`);
    }
  };
  const server = createServer((request, response) => {
    route(request, response).catch((error) => {
      routeFailures.push(error);
      reply(response, 500, { error: "fixture_route_failed" });
    });
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseURL = `http://127.0.0.1:${server.address().port}`;
    const createService = () => createCompanionAccountService({
      client: createControlPlaneClient({ baseURL, timeoutMs: 2_000 }),
      readCredentials: () => structuredClone(document),
      updateCredentials: async (derive) => {
        document = structuredClone(await derive(structuredClone(document)));
        return structuredClone(document);
      },
      identity,
      newClientInstanceId: () => {
        identitiesCreated += 1;
        return CLIENT_ID;
      },
      companionIsOn: () => true,
      managedConnectionState: () => ({ status: activations ? "ready" : "stopped", ready: activations > 0 }),
      activatePersistedEndpoint: async () => {
        assert.equal(document[MANAGED_COMPANION_ENDPOINT_FIELD], ENDPOINT);
        assert.equal(document[MANAGED_COMPANION_TOKEN_FIELD], CONNECTOR_TOKEN);
        activations += 1;
        return { status: "ready", ready: true };
      },
    });
    const expectedRetained = {
      unrelatedCredential: "keep-fixture-value",
      [COMPANION_CLIENT_INSTANCE_FIELD]: CLIENT_ID,
      [COMPANION_ACCOUNT_EMAIL_FIELD]: EMAIL,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "fixture-user",
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_INSTALLATION_ID_FIELD]: INSTALLATION_ID,
      [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: INSTALLATION_CREDENTIAL,
      [COMPANION_INSTALLATION_EXPIRY_FIELD]: credentialExpiresAt,
    };
    const assertEndpointFailure = (state) => {
      assert.deepEqual(routeFailures, []);
      assert.equal(state.available, true, "a healthy service remains available despite provisioning failure");
      assert.equal(state.status, "error");
      assert.equal(state.email, EMAIL);
      assert.match(state.message, /could not finish setup/);
      assert.match(state.message, new RegExp(`Reference: ${REQUEST_ID}`));
      assert.doesNotMatch(state.message, /reconnected too often|Too many attempts/);
      assert.deepEqual(document, expectedRetained);
      assert.equal(activations, 0);
    };
    const service = createService();
    await service.requestCode(EMAIL);
    assertEndpointFailure(await service.verifyCode(EMAIL, "12345678"));
    assertEndpointFailure(await service.retry());

    const restarted = createService();
    assertEndpointFailure(await restarted.restore());
    endpointReady = true;
    const ready = await restarted.retry();
    assert.deepEqual(routeFailures, []);
    assert.deepEqual(ready, { available: true, status: "ready", email: EMAIL, endpoint: ENDPOINT });
    assert.deepEqual(document, {
      ...expectedRetained,
      [MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
      [MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
      [MANAGED_COMPANION_ORIGIN_VERSION_FIELD]: MANAGED_COMPANION_ORIGIN_VERSION,
    });
    assert.equal(activations, 1);
    assert.equal(identitiesCreated, 1);
    const count = (key) => calls.filter((call) => call === key).length;
    assert.equal(count("POST /api/auth/email-otp/send-verification-otp"), 1);
    assert.equal(count("POST /api/auth/sign-in/email-otp"), 1);
    assert.equal(count("GET /v1/installations"), 1);
    assert.equal(count("POST /v1/installations"), 1);
    assert.equal(count("GET /v1/installations/self"), 3);
    assert.equal(count("POST /v1/installations/self/endpoint"), 4);
    assert.equal(count(`POST /v1/installations/${INSTALLATION_ID}/credentials/rotate`), 0);
    assert.ok(count("GET /healthz") >= 4);
    for (const secret of [ACCOUNT_TOKEN, INSTALLATION_CREDENTIAL, CONNECTOR_TOKEN]) {
      assert.ok(!JSON.stringify(ready).includes(secret), "public state must not expose fixture secrets");
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
