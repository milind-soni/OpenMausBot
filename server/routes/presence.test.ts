import { describe, expect, it, vi } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { createPresenceRoutes } from "./presence.ts";

function call(auth: RequestAuth, body: unknown, active = vi.fn(async () => ({ returned: true }))) {
  const answers: Array<[number, unknown]> = [];
  const route = createPresenceRoutes({ isOwner: (who) => who.scopes.includes("admin"), active });
  const done = route({
    req: {} as never, res: {} as never, url: new URL("http://x/api/presence/active"), path: "/api/presence/active", method: "POST", auth,
    json: ((_res: unknown, status: number, value: unknown) => { answers.push([status, value]); }) as never, readBody: (async () => body) as never,
  });
  return { done, answers, active };
}

describe("POST /api/presence/active", () => {
  it("records only the owner's activation, with a time zone it can read", async () => {
    const owner = call({ kind: "loopback", scopes: ["admin", "client"] }, { source: "phone", timeZone: "Asia/Kolkata" });
    await owner.done;
    expect(owner.active).toHaveBeenCalledWith("phone", "Asia/Kolkata");
    expect(owner.answers).toEqual([[200, { ok: true, returned: true }]]);
    const odd = call({ kind: "loopback", scopes: ["admin", "client"] }, { timeZone: "Not/A Zone; drop" });
    await odd.done;
    expect(odd.active).toHaveBeenCalledWith("desktop", undefined);
  });

  it("answers a guest without recording anything", async () => {
    const guest = call({ kind: "loopback", scopes: ["client"], trust: "service" }, { source: "desktop" });
    await guest.done;
    expect(guest.active).not.toHaveBeenCalled();
    expect(guest.answers).toEqual([[200, { ok: true, returned: false }]]);
  });
});
