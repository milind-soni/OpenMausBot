import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlClient } from "./control-client.ts";

const options = { url: "http://control.test/state", token: "fixture-token" };
const unavailable = { held: true, helpOpen: false };

afterEach(() => vi.restoreAllMocks());

describe("computer control client", () => {
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
      await expect(client.requestHelp("fixture request")).resolves.toBeNull();
      await client.expireHelp("fixture-request");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("caches for 750 ms and refreshes immediately when requested", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const released = { held: false, helpOpen: false };
    const held = { ...unavailable, blockedReason: "Computer reserved." };
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
