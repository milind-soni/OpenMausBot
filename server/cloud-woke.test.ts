import { describe, expect, it, vi } from "vitest";
import { createWokeNotifier, wokeSignature, WOKE_ADMIN_PATH } from "./cloud-woke.ts";

const options = { adminOrigin: "https://admin.test", machineId: "cm_1", secret: "s".repeat(43) };

describe("the wake notice to the Admin", () => {
  it("is signed over its body with this machine's secret", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); return new Response("{}", { status: 200 }); });
    createWokeNotifier({ ...options, fetcher: fetcher as never, now: () => 1_700_000_000_000 })();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const [{ url, init }] = calls;
    expect(url).toBe(`https://admin.test${WOKE_ADMIN_PATH}`);
    expect(init.body).toBe(JSON.stringify({ v: 1, wokeAt: 1_700_000_000_000 }));
    const headers = init.headers as Record<string, string>;
    expect(headers["x-omb-cloud-machine"]).toBe("cm_1");
    expect(headers["x-omb-cloud-signature"]).toBe(`v1=${wokeSignature(options.secret, "cm_1", headers["x-omb-cloud-timestamp"]!, headers["x-omb-cloud-nonce"]!, init.body as string)}`);
  });
  it("an older Admin that doesn't know it, or an Admin that can't be reached, changes nothing and is said once", async () => {
    const log = vi.fn();
    const older = createWokeNotifier({ ...options, log, fetcher: (async () => new Response("", { status: 404 })) as never });
    older();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(log).not.toHaveBeenCalled();
    const down = createWokeNotifier({ ...options, log, fetcher: (async () => { throw new TypeError("network"); }) as never });
    down(); down();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(log.mock.calls[0]![0]).toMatch(/could not reach the Admin/);
  });
});
