import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  ControlPlaneError,
  createControlPlaneClient,
  normalizeAccountEmail,
  normalizeControlPlaneURL,
} from "./control-plane-client.mjs";

const ACCOUNT = `signed.${"a".repeat(40)}`;
const INSTALL = `omb_install_${"a".repeat(22)}.${"b".repeat(43)}`;
const INSTALL_ID = "11111111-1111-4111-8111-111111111111";
const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });

describe("control-plane desktop client", () => {
  it("accepts exact HTTPS and loopback development origins only", () => {
    expect(normalizeControlPlaneURL("https://accounts.openmausbot.com/")).toBe(
      "https://accounts.openmausbot.com",
    );
    expect(normalizeControlPlaneURL("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeControlPlaneURL("http://accounts.openmausbot.com")).toBe("");
    expect(normalizeControlPlaneURL("https://accounts.openmausbot.com/api")).toBe("");
    expect(normalizeControlPlaneURL("https://user:secret@accounts.openmausbot.com")).toBe("");
  });

  it("normalizes an email without accepting malformed input", () => {
    expect(normalizeAccountEmail(" Ada@Example.COM ")).toBe("ada@example.com");
    expect(normalizeAccountEmail("not-an-email")).toBe("");
    expect(normalizeAccountEmail(new String("ada@example.com"))).toBe("");
    expect(normalizeControlPlaneURL({ toString: () => "https://accounts.openmausbot.com" })).toBe("");
  });

  it("accepts plain cross-realm response records", async () => {
    const payload = runInNewContext(
      "({ user: { id: 'user-1', email: 'ada@example.com' } })",
    );
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ "set-auth-token": ACCOUNT }),
        json: async () => payload,
      })),
    });

    await expect(client.verifyOTP("ada@example.com", "12345678")).resolves.toEqual({
      accountToken: ACCOUNT,
      user: { id: "user-1", email: "ada@example.com" },
    });
  });

  it("rejects non-plain response records instead of coercing them", async () => {
    class Payload {
      constructor() {
        this.user = { id: "user-1", email: "ada@example.com" };
      }
    }
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => new Payload(),
      })),
    });

    await expect(client.me(ACCOUNT)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("requires the exact healthy control-plane identity before onboarding", async () => {
    const timeoutSignal = vi.fn(() => new AbortController().signal);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, service: "openmausbot-control-plane" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, service: "some-other-service" }));
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl,
      timeoutSignal,
    });

    await expect(client.health()).resolves.toBe(true);
    await expect(client.health()).rejects.toMatchObject({
      code: "control_plane_unavailable",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://accounts.openmausbot.com/healthz");
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("error");
    expect(timeoutSignal).toHaveBeenNthCalledWith(1, 3_000);
  });

  it("uses the signed Better Auth bearer header, never its raw JSON token", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(JSON.parse(init.body)).toEqual({
        email: "ada@example.com",
        otp: "12345678",
        name: "ada",
      });
      return jsonResponse(
        { token: "raw-database-token-must-not-be-used", user: { id: "user-1", email: "ada@example.com" } },
        { headers: { "set-auth-token": ACCOUNT } },
      );
    });
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl,
    });

    await expect(client.verifyOTP("Ada@Example.com", "1234-5678")).resolves.toEqual({
      accountToken: ACCOUNT,
      user: { id: "user-1", email: "ada@example.com" },
    });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("raw-database-token-must-not-be-used");
  });

  it("keeps a valid installation credential without rotating it", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(url).toBe("https://accounts.openmausbot.com/v1/installations/self");
      return jsonResponse({
        installation: {
          id: INSTALL_ID,
          clientInstanceId: "client-1",
          name: "Mac",
          platform: "darwin",
          appVersion: "1.0.0",
        },
        credentialExpiresAt: Date.now() + 10_000,
      });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    const result = await client.ensureInstallation({
      accountToken: ACCOUNT,
      currentCredential: INSTALL,
      clientInstanceId: "client-1",
      name: "Mac",
      platform: "darwin",
      appVersion: "1.0.0",
    });
    expect(result.credential).toBe(INSTALL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost installation credential by rotating the matching identity", async () => {
    const rotated = `omb_install_${"c".repeat(22)}.${"d".repeat(43)}`;
    const fetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith("/v1/installations")) {
        return jsonResponse({
          installations: [{ id: INSTALL_ID, clientInstanceId: "client-1", name: "Mac", platform: "darwin" }],
        });
      }
      expect(url).toContain(`/v1/installations/${INSTALL_ID}/credentials/rotate`);
      expect(init.method).toBe("POST");
      return jsonResponse({ credential: rotated, credentialExpiresAt: Date.now() + 10_000 }, { status: 201 });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    await expect(client.ensureInstallation({
      accountToken: ACCOUNT,
      clientInstanceId: "client-1",
      name: "Mac",
      platform: "darwin",
      appVersion: "1.0.0",
    })).resolves.toMatchObject({ credential: rotated, installation: { id: INSTALL_ID } });
  });

  it("lists validated active installations for response-loss cleanup", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://accounts.openmausbot.com/v1/installations");
      expect(init.headers.get("authorization")).toBe(`Bearer ${ACCOUNT}`);
      return jsonResponse({
        installations: [{
          id: INSTALL_ID,
          clientInstanceId: "client-1",
          name: "Mac",
          platform: "darwin",
          appVersion: "1.0.0",
        }],
      });
    });
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl,
    });

    await expect(client.listInstallations(ACCOUNT)).resolves.toEqual([{
      id: INSTALL_ID,
      clientInstanceId: "client-1",
      name: "Mac",
      platform: "darwin",
      appVersion: "1.0.0",
    }]);
  });

  it("rejects malformed installation lists instead of skipping cleanup targets", async () => {
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => jsonResponse({
        installations: [{ id: "not-an-installation", clientInstanceId: "client-1" }],
      })),
    });

    await expect(client.listInstallations(ACCOUNT)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("validates endpoint material without leaking the connector token into the URL", async () => {
    const connectorToken = `eyJ${"x".repeat(80)}`;
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://accounts.openmausbot.com/v1/installations/self/endpoint");
      expect(init.headers.get("authorization")).toBe(`Bearer ${INSTALL}`);
      expect(url).not.toContain(connectorToken);
      return jsonResponse({ endpoint: { url: "https://c-opaque.openmausbot.com" }, connectorToken });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    await expect(client.ensureEndpoint(INSTALL)).resolves.toEqual({
      endpoint: { url: "https://c-opaque.openmausbot.com" },
      connectorToken,
    });
  });

  it("maps bounded server error codes and hides arbitrary response text", async () => {
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => jsonResponse({ error: "rate_limited", detail: "secret detail" }, { status: 429 })),
    });
    await expect(client.requestOTP("ada@example.com")).rejects.toMatchObject({
      name: "ControlPlaneError",
      code: "rate_limited",
      status: 429,
    });
  });

  it("falls back from Better Auth's message-only 429 without exposing its prose", async () => {
    const requestId = "44444444-4444-4444-8444-444444444444";
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => jsonResponse(
        { message: "Too many requests. Please try again later." },
        { status: 429, headers: { "x-request-id": requestId } },
      )),
    });

    await expect(client.requestOTP("ada@example.com")).rejects.toMatchObject({
      name: "ControlPlaneError",
      code: "rate_limited",
      status: 429,
      requestId,
    });
  });

  it("uses stable status errors when a response has no public error contract", async () => {
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => jsonResponse(
        { code: "INTERNAL_DEPENDENCY_DETAIL", message: "do not expose this" },
        { status: 400, headers: { "x-request-id": "not-a-safe-request-id" } },
      )),
    });

    await expect(client.requestOTP("ada@example.com")).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
      requestId: "",
    });
  });

  it("fails closed on redirects and network errors", async () => {
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("redirect blocked");
      }),
    });
    await expect(client.requestOTP("ada@example.com")).rejects.toEqual(
      expect.objectContaining({ code: "network_unavailable" }),
    );
    expect(() => createControlPlaneClient({ baseURL: "http://remote.example" })).toThrow(
      ControlPlaneError,
    );
  });
});
