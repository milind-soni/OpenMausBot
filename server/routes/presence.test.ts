import { describe, expect, it, vi } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { createPresenceRoutes } from "./presence.ts";

function call(auth: RequestAuth, body: unknown, active = vi.fn(async () => ({ returned: true })), sawChat = vi.fn()) {
  const answers: Array<[number, unknown]> = [];
  const route = createPresenceRoutes({ isOwner: (who) => who.scopes.includes("admin"), active, sawChat });
  const done = route({
    req: {} as never, res: {} as never, url: new URL("http://x/api/presence/active"), path: "/api/presence/active", method: "POST", auth,
    json: ((_res: unknown, status: number, value: unknown) => { answers.push([status, value]); }) as never, readBody: (async () => body) as never,
  });
  return { done, answers, active, sawChat };
}

describe("POST /api/presence/active", () => {
  it("records only the owner's activation, with a time zone and language it can read", async () => {
    const owner = call({ kind: "loopback", scopes: ["admin", "client"] }, { source: "phone", timeZone: "Asia/Kolkata", language: "pt-BR" });
    await owner.done;
    expect(owner.active).toHaveBeenCalledWith("phone", "Asia/Kolkata", "pt-br");
    expect(owner.answers).toEqual([[200, { ok: true, returned: true }]]);
    const odd = call({ kind: "loopback", scopes: ["admin", "client"] }, { timeZone: "Not/A Zone; drop", language: "<script>" });
    await odd.done;
    expect(odd.active).toHaveBeenCalledWith("desktop", undefined, undefined);
  });

  it("answers a guest without recording anything", async () => {
    const guest = call({ kind: "loopback", scopes: ["client"], trust: "service" }, { source: "desktop" });
    await guest.done;
    expect(guest.active).not.toHaveBeenCalled();
    expect(guest.answers).toEqual([[200, { ok: true, returned: false }]]);
  });

  it("passes on the conversation open in the app, and only a well-formed id", async () => {
    const owner = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
    const open = call(owner, { source: "desktop", language: "en", threadId: "3f2a-thread_1" });
    await open.done;
    expect(open.sawChat).toHaveBeenCalledWith(owner, "3f2a-thread_1");
    for (const threadId of ["../etc", "x".repeat(101), 42, ""]) {
      const odd = call(owner, { threadId });
      await odd.done;
      expect(odd.sawChat).not.toHaveBeenCalled();
    }
  });
});
