import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_REFUSAL_PLAIN, CONTROL_UNCONFIRMED, CONTROL_WAIT_MS, controlRefusal, createControlClient,
} from "./control-client.ts";

const options = { url: "http://control.test/state", token: "fixture-token" };
const unavailable = { held: true, helpOpen: false, blockedReason: CONTROL_UNCONFIRMED };

/** A real loopback control endpoint answering `body` after `delayMs`, or
 * never: the client's own timeout is what these tests exercise. */
async function slowControl(delayMs: number | null, body: unknown) {
  const server = createServer((_request, response) => {
    if (delayMs === null) return;
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/internal/computer-control?botId=b`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("computer control client", () => {
  it("waits out a harness that holds the check longer than the old 2 s, and keeps its contention reason", async () => {
    // The gate holds a check while the computer is busy; an early client abort would turn this answer into "A person has taken control".
    const busy = { held: true, helpOpen: false, blockedReason: "Another thread is using this computer." };
    const control = await slowControl(3_000, busy);
    try {
      const state = await createControlClient({ url: control.url, token: "t" }).state(true);
      expect(state).toEqual(busy);
      expect(controlRefusal(state)).toBe(busy.blockedReason);
    } finally { await control.close(); }
  }, 10_000);

  it("carries what a call would open to the gate, and never answers such a call from the cache", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ held: false, helpOpen: false }));
    const client = createControlClient({ url: "http://control.test/api/internal/computer-control?botId=b", token: "t", fetchImpl });
    await client.state(false);
    await client.state(false, { app: "Chrome", site: "calendar.google.com" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const sent = new URL(String(fetchImpl.mock.calls[1]![0]));
    expect(Object.fromEntries(sent.searchParams)).toEqual({ botId: "b", app: "Chrome", site: "calendar.google.com" });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://control.test/api/internal/computer-control?botId=b");
  });

  it("outlasts the harness's longest hold", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ held: false, helpOpen: false }));
    await createControlClient({ ...options, fetchImpl }).state(true);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout.mock.calls[0]![0]).toBeGreaterThan(CONTROL_WAIT_MS);
    expect(fetchImpl.mock.calls[0]![1]!.signal).toBe(timeout.mock.results[0]!.value);
  });

  it("says it could not confirm, not that a person took control, when its own timeout fires", async () => {
    const control = await slowControl(null, null);
    try {
      const state = await createControlClient({ url: control.url, token: "t", timeoutMs: 200 }).state(true);
      expect(state).toEqual(unavailable);
      expect(controlRefusal(state)).toBe(CONTROL_UNCONFIRMED);
      expect(controlRefusal(state)).not.toBe(CONTROL_REFUSAL_PLAIN);
    } finally { await control.close(); }
  });

  it("keeps the person's hold only when the harness names it", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ held: true, helpOpen: false, reason: "person" }))
      .mockResolvedValueOnce(Response.json({ held: true, helpOpen: false, reason: "someone" }));
    const client = createControlClient({ ...options, fetchImpl });
    const person = await client.state(true);
    expect(person).toEqual({ held: true, helpOpen: false, reason: "person" });
    expect(controlRefusal(person)).toBe(CONTROL_REFUSAL_PLAIN);
    const unknown = await client.state(true);
    expect(unknown).toEqual({ held: true, helpOpen: false });
    expect(controlRefusal(unknown)).toBe(CONTROL_UNCONFIRMED);
  });

  it("preserves a held state's custom blocked reason", async () => {
    const state = { held: true, helpOpen: true, blockedReason: "Another task owns this computer." };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(state));
    const client = createControlClient({ ...options, fetchImpl });

    expect(client.configured).toBe(true);
    await expect(client.state()).resolves.toEqual(state);
    expect(fetchImpl).toHaveBeenCalledWith(options.url, expect.objectContaining({
      headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    }));
  });

  it.each([null, {}, [], { helpOpen: true }, { held: "false" }, { held: 0 }])(
    "fails closed for malformed state %j",
    async (body) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
      await expect(createControlClient({ ...options, fetchImpl }).state()).resolves.toEqual(unavailable);
    },
  );

  it("fails closed when the response is not JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("invalid JSON"));
    await expect(createControlClient({ ...options, fetchImpl }).state()).resolves.toEqual(unavailable);
  });

  it.each([401, 403, 500])("fails closed for HTTP %i", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ held: false }, { status }));
    await expect(createControlClient({ ...options, fetchImpl }).state()).resolves.toEqual(unavailable);
  });

  it("fails closed when the request rejects", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    await expect(createControlClient({ ...options, fetchImpl }).state()).resolves.toEqual(unavailable);
  });

  it("ignores non-string blocked reasons without changing a valid state", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      held: false, helpOpen: false, blockedReason: { message: "untrusted" },
    }));
    await expect(createControlClient({ ...options, fetchImpl }).state()).resolves.toEqual({
      held: false, helpOpen: false,
    });
  });

  it.each([{ url: "", token: options.token }, { url: options.url, token: "" }])(
    "stays disengaged without complete configuration %j",
    async (configuration) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const client = createControlClient({ ...configuration, fetchImpl });
      expect(client.configured).toBe(false);
      await expect(client.state(true)).resolves.toEqual({ held: false, helpOpen: false });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("caches for 750 ms and refreshes immediately when requested", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const released = { held: false, helpOpen: false };
    const held = { held: true, helpOpen: false, blockedReason: "Computer reserved." };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(released))
      .mockResolvedValueOnce(Response.json(held))
      .mockResolvedValueOnce(Response.json(released));
    const client = createControlClient({ ...options, fetchImpl });

    await expect(client.state()).resolves.toEqual(released);
    now.mockReturnValue(10_749);
    await expect(client.state()).resolves.toEqual(released);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now.mockReturnValue(10_750);
    await expect(client.state()).resolves.toEqual(held);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(client.state(true)).resolves.toEqual(released);
    await expect(client.state()).resolves.toEqual(released);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
