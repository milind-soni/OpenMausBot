import { afterEach, describe, expect, it } from "vitest";

import { DshApiClient, DshRpcError } from "./client.ts";
import { dshClientRequestSchema, dshJsonValueSchema } from "./protocol.ts";
import { FakeDshHost } from "../../testing/fake-dsh-host.ts";

const hosts: FakeDshHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
});

async function host(): Promise<FakeDshHost> {
  const fake = new FakeDshHost();
  hosts.push(fake);
  await fake.start();
  return fake;
}

describe("DshApiClient unary transport", () => {
  it("uses the direct API path and correlates the returned rpc id", async () => {
    const fake = await host();
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });

    const result = await client.unary<{ name: string }>("host.describe", {});

    expect(result.value).toEqual({});
    expect(result.rpcId).toMatch(/^[a-z0-9-]+$/);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      path: "/api/host.describe",
      headers: { "content-type": "application/json" },
      body: { type: "client-request", method: "host.describe", rpcId: result.rpcId, payload: {} },
    });
    client.close();
  });

  it("uses the paired API path and sends the device cookie only as a header", async () => {
    const fake = await host();
    const client = new DshApiClient({
      baseUrl: fake.baseUrl,
      transport: "paired",
      deviceCookie: "dsh_device=fixture-value",
    });

    await client.unary("llm.models", {});

    expect(fake.requests[0]).toMatchObject({
      path: "/remote/api/llm.models",
      headers: { cookie: "dsh_device=fixture-value" },
    });
    expect(fake.requests[0].path).not.toContain("fixture-value");
    client.close();
  });

  it("rejects path-segment methods before a paired request is emitted", async () => {
    const fake = await host();
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_device=fixture-value" });

    await expect(client.unary("x/../../../api/settings.describe", {})).rejects.toThrow("DSH API method is invalid");

    expect(fake.requests).toEqual([]);
    client.close();
  });

  it("rejects the paired plugin loopback-only method surface without issuing requests", async () => {
    const fake = await host();
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_device=fixture-value" });
    const loopbackOnlyMethods = [
      "settings.describe",
      "settings.mutate",
      "credentials.describe",
      "credentials.set",
      "llm.discoverModels",
      "agentPreset.read",
      "agentPreset.copy",
      "agentPreset.openDocument",
      "agentPreset.remove",
      "host.pickDirectory",
      "host.openPath",
    ];

    for (const method of loopbackOnlyMethods) {
      await expect(client.unary(method, {})).rejects.toThrow("DSH method is not available through paired transport");
    }

    expect(fake.requests).toEqual([]);
    client.close();
  });

  it("allows the paired model, preset-list, and session surfaces", async () => {
    const fake = await host();
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_device=fixture-value" });

    await client.unary("llm.models", {});
    await client.unary("agentPreset.list", {});
    await client.unary("session.create", {});

    expect(fake.requests.map((request) => request.path)).toEqual([
      "/remote/api/llm.models",
      "/remote/api/agentPreset.list",
      "/remote/api/session.create",
    ]);
    client.close();
  });

  it("rejects mismatched response rpc ids", async () => {
    const fake = await host();
    fake.onRequest = () => {
      return dshJsonValueSchema.parse({ type: "server-response", rpcId: "a-different-rpc-id", result: { ok: true, value: {} } });
    };
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });

    await expect(client.unary("host.describe", {})).rejects.toThrow("DSH response rpc id did not match request");
    client.close();
  });

  it("keeps paired device cookies out of DSH business-error text", async () => {
    const fake = await host();
    const deviceCookie = "dsh_device=fixture-secret-value";
    fake.onRequest = ({ body }) => {
      const rpcId = dshClientRequestSchema.parse(body).rpcId;
      return dshJsonValueSchema.parse({
        type: "server-response",
        rpcId,
        result: { ok: false, error: { code: "model-unavailable", message: `reflected ${deviceCookie}` } },
      });
    };
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie });

    await expect(client.unary("llm.models", {})).rejects.toBeInstanceOf(DshRpcError);
    await expect(client.unary("llm.models", {})).rejects.toThrow("DSH request was rejected (model-unavailable)");
    try {
      await client.unary("llm.models", {});
    } catch (error) {
      expect(error).toBeInstanceOf(DshRpcError);
      expect(String(error)).not.toContain(deviceCookie);
    }
    client.close();
  });

  it("rejects a chunked oversized response before the host finishes it", async () => {
    const fake = await host();
    fake.onRawRequest = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      response.write("x".repeat(1_000_001));
      return true;
    };
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });
    const result = client.unary("host.describe", {});

    await fake.waitForRawResponse();
    const closed = fake.waitForRawResponseClose();
    await expect(result).rejects.toThrow("DSH response exceeds the size limit");
    await closed;
    client.close();
  });

  it("sends client-response envelopes to the respond endpoint", async () => {
    const fake = await host();
    fake.onRequest = () => ({ accepted: true });
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });

    await expect(client.respond("approval-1", { ok: true, value: { allow: true } })).resolves.toEqual({ accepted: true });

    expect(fake.requests[0]).toMatchObject({
      path: "/api/respond",
      body: { type: "client-response", rpcId: "approval-1", result: { ok: true, value: { allow: true } } },
    });
    client.close();
  });
});

describe("DshApiClient event streams", () => {
  it("connects both streams, ignores malformed frames, reconnects, and tears down cleanly", async () => {
    const fake = await host();
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_device=fixture-value" });
    const muxFrames: unknown[] = [];
    const hostFrames: unknown[] = [];
    const firstMux = deferred();
    const secondMux = deferred();
    const firstHost = deferred();
    const stopMux = client.subscribeMux((frame) => {
      muxFrames.push(frame);
      if (muxFrames.length === 1) firstMux.resolve();
      if (muxFrames.length === 2) secondMux.resolve();
    });
    const stopHost = client.subscribeHost((frame) => {
      hostFrames.push(frame);
      if (hostFrames.length === 1) firstHost.resolve();
    });

    await Promise.all([fake.waitForStream("mux"), fake.waitForStream("host")]);
    expect(fake.streamHeaders.mux[0].cookie).toBe("dsh_device=fixture-value");
    expect(fake.streamHeaders.host[0].cookie).toBe("dsh_device=fixture-value");
    fake.sendRaw("mux", "not JSON");
    fake.send("mux", { type: "unexpected", rpcId: "nope" });
    fake.send("mux", { type: "server-request", rpcId: "mux-1", method: "session/event", payload: { sessionId: "s1" } });
    fake.send("host", { type: "server-request", rpcId: "host-1", method: "host/status", payload: { ready: true } });

    await Promise.all([firstMux.promise, firstHost.promise]);
    expect(muxFrames).toEqual([{ type: "server-request", rpcId: "mux-1", method: "session/event", payload: { sessionId: "s1" } }]);
    expect(hostFrames).toEqual([{ type: "server-request", rpcId: "host-1", method: "host/status", payload: { ready: true } }]);

    const muxClosed = fake.waitForNoStreams("mux");
    fake.closeStreams("mux");
    await muxClosed;
    await fake.waitForStream("mux");
    fake.send("mux", { type: "server-request", rpcId: "mux-2", method: "session/event", payload: { sessionId: "s2" } });
    await secondMux.promise;

    stopMux();
    stopHost();
    const allClosed = Promise.all([fake.waitForNoStreams("mux"), fake.waitForNoStreams("host")]);
    client.close();
    await allClosed;
  });
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
