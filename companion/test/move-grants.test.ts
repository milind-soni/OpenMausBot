import { beforeEach, describe, expect, it } from "vitest";

import { MOVE_ASK_TTL_MS, MOVE_GRANT_TTL_MS, MoveGrants } from "../src/move-grants.ts";

let now = 1_000;
let grants: MoveGrants;
beforeEach(() => {
  now = 1_000;
  grants = new MoveGrants(() => now);
});
const ASKED = 1_000 + MOVE_ASK_TTL_MS;
const allowPending = (id: string) => {
  const state = grants.state(id);
  return state.state === "pending" && grants.allow(id, state.expiresAt);
};

describe("move grants", () => {
  it("an ask waits for the owner, and Allow grants that phone alone for 30 minutes", () => {
    expect(grants.ask("phone-1", 4)).toEqual({ created: true, state: { state: "pending", bots: 4, expiresAt: 1_000 + MOVE_ASK_TTL_MS } });
    expect(grants.live("phone-1")).toBe(false);
    expect(grants.allow("phone-1", ASKED)).toBe(true);
    expect(grants.state("phone-1")).toEqual({ state: "granted", expiresAt: 1_000 + MOVE_GRANT_TTL_MS });
    expect(grants.live("phone-1")).toBe(true);
    expect(grants.live("phone-2")).toBe(false);
  });

  it("asking again while an ask waits or a grant is live raises no second ask", () => {
    grants.ask("phone-1", 4);
    expect(grants.ask("phone-1", 9).created).toBe(false);
    grants.allow("phone-1", ASKED);
    expect(grants.ask("phone-1", 4)).toEqual({ created: false, state: { state: "granted", expiresAt: 1_000 + MOVE_GRANT_TTL_MS } });
  });

  it("Don't Allow is final for that ask; the phone may ask again only after 5 minutes", () => {
    grants.ask("phone-1", 4);
    now += 60_000;
    grants.refuse("phone-1");
    expect(grants.state("phone-1")).toEqual({ state: "refused" });
    expect(grants.allow("phone-1", ASKED)).toBe(false);
    expect(grants.ask("phone-1", 4)).toEqual({ created: false, state: { state: "refused" } });
    now += MOVE_ASK_TTL_MS - 1;
    expect(grants.ask("phone-1", 4).created).toBe(false);
    now += 1;
    expect(grants.ask("phone-1", 4).created).toBe(true);
  });

  it("a revoked grant also keeps the phone from asking again for 5 minutes", () => {
    grants.ask("phone-1", 4);
    grants.allow("phone-1", ASKED);
    now += 20 * 60_000;
    grants.refuse("phone-1");
    expect(grants.ask("phone-1", 4).created).toBe(false);
    now += MOVE_ASK_TTL_MS;
    expect(grants.ask("phone-1", 4).created).toBe(true);
  });

  it("the phone ending its own ask does not let it ask again sooner", () => {
    grants.ask("phone-1", 4);
    grants.end("phone-1");
    expect(grants.ask("phone-1", 4)).toEqual({ created: false, state: { state: "none" } });
    now += MOVE_ASK_TTL_MS;
    expect(grants.ask("phone-1", 4).created).toBe(true);
  });

  it("an ask the owner never saw is withdrawn without holding back the next", () => {
    grants.ask("phone-1", 4);
    grants.withdraw("phone-1");
    expect(grants.state("phone-1")).toEqual({ state: "none" });
    expect(grants.ask("phone-1", 4).created).toBe(true);
  });

  it("an unanswered ask expires after 5 minutes and can no longer be allowed", () => {
    grants.ask("phone-1", 4);
    now += MOVE_ASK_TTL_MS;
    expect(grants.state("phone-1")).toEqual({ state: "expired" });
    expect(grants.allow("phone-1", ASKED)).toBe(false);
    expect(grants.ask("phone-1", 4).created).toBe(true);
  });

  it("a grant ends at 30 minutes, on the owner's revoke and on the phone's own end", () => {
    grants.ask("a", 1);
    allowPending("a");
    now += MOVE_GRANT_TTL_MS;
    expect(grants.live("a")).toBe(false);
    expect(grants.state("a")).toEqual({ state: "expired" });
    grants.ask("b", 1);
    allowPending("b");
    grants.refuse("b");
    expect(grants.live("b")).toBe(false);
    expect(grants.state("b")).toEqual({ state: "refused" });
    grants.ask("c", 1);
    allowPending("c");
    grants.end("c");
    expect(grants.state("c")).toEqual({ state: "none" });
  });

  it("Allow grants only the ask whose expiry it names", () => {
    grants.ask("phone-1", 4);
    expect(grants.allow("phone-1", ASKED - 1)).toBe(false);
    expect(grants.allow("phone-1", Number.NaN)).toBe(false);
    expect(grants.state("phone-1")).toEqual({ state: "pending", bots: 4, expiresAt: ASKED });
    expect(grants.allow("phone-1", ASKED)).toBe(true);
  });

  it("after a restart, an Allow for the ask before it never grants the phone's new ask", () => {
    grants.ask("phone-1", 4);
    now = 2_000;
    const restarted = new MoveGrants(() => now);
    expect(restarted.ask("phone-1", 9).created).toBe(true);
    expect(restarted.allow("phone-1", ASKED)).toBe(false);
    expect(restarted.state("phone-1")).toEqual({ state: "pending", bots: 9, expiresAt: 2_000 + MOVE_ASK_TTL_MS });
    expect(restarted.allow("phone-1", 2_000 + MOVE_ASK_TTL_MS)).toBe(true);
  });
});
