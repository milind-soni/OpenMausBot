import { describe, expect, it } from "vitest";

import { canWriteIn } from "./cloud-guest";
import { readSessionState } from "./session";

const answer = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("where a device may write on an OMB Cloud home", () => {
  it("a guest writes only in the conversations it opened; the owner's devices and every other server anywhere", async () => {
    const guest = await readSessionState(answer({ kind: "session", id: "s1", label: "Guest phone", scopes: ["client"], expiresAt: 1, cloudHome: true, cloudGuest: true, openedThreads: ["t-mine", 7] }));
    expect(guest).toMatchObject({ kind: "session", cloudGuest: true, openedThreads: ["t-mine"] });
    expect(canWriteIn(guest, "t-mine")).toBe(true);
    expect(canWriteIn(guest, "t-owners")).toBe(false);
    const owner = await readSessionState(answer({ kind: "session", id: "s2", label: "Mac", scopes: ["admin", "client"], expiresAt: 1, cloudHome: true }));
    expect(owner).not.toHaveProperty("cloudGuest");
    expect(canWriteIn(owner, "t-owners")).toBe(true);
    expect(canWriteIn(await readSessionState(answer({ kind: "loopback", scopes: ["admin", "client"] })), "t-owners")).toBe(true);
    expect(canWriteIn(null, "t-owners")).toBe(true);
  });
});
