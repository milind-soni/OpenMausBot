import { beforeEach, describe, expect, it } from "vitest";

import { MOVE_ASK_TTL_MS, MOVE_GRANT_TTL_MS, MoveGrants } from "../src/move-grants.ts";

let now = 1_000;
let grants: MoveGrants;
beforeEach(() => {
  now = 1_000;
  grants = new MoveGrants(() => now);
});

describe("move grants", () => {
  it("an ask waits for the owner, and Allow grants that phone alone for 30 minutes", () => {
    expect(grants.ask("phone-1", 4)).toEqual({ created: true, state: { state: "pending", bots: 4, expiresAt: 1_000 + MOVE_ASK_TTL_MS } });
    expect(grants.live("phone-1")).toBe(false);
    expect(grants.allow("phone-1")).toBe(true);
    expect(grants.state("phone-1")).toEqual({ state: "granted", expiresAt: 1_000 + MOVE_GRANT_TTL_MS });
    expect(grants.live("phone-1")).toBe(true);
    expect(grants.live("phone-2")).toBe(false);
  });

  it("asking again while an ask waits or a grant is live raises no second ask", () => {
    grants.ask("phone-1", 4);
    expect(grants.ask("phone-1", 9).created).toBe(false);
    grants.allow("phone-1");
    expect(grants.ask("phone-1", 4)).toEqual({ created: false, state: { state: "granted", expiresAt: 1_000 + MOVE_GRANT_TTL_MS } });
  });

  it("Don't Allow is final for that ask; the phone may ask again later", () => {
    grants.ask("phone-1", 4);
    grants.refuse("phone-1");
    expect(grants.state("phone-1")).toEqual({ state: "refused" });
    expect(grants.allow("phone-1")).toBe(false);
    expect(grants.ask("phone-1", 4).created).toBe(true);
  });

  it("an unanswered ask expires after 5 minutes and can no longer be allowed", () => {
    grants.ask("phone-1", 4);
    now += MOVE_ASK_TTL_MS;
    expect(grants.state("phone-1")).toEqual({ state: "expired" });
    expect(grants.allow("phone-1")).toBe(false);
    expect(grants.ask("phone-1", 4).created).toBe(true);
  });

  it("a grant ends at 30 minutes, on the owner's revoke and on the phone's own end", () => {
    grants.ask("a", 1);
    grants.allow("a");
    now += MOVE_GRANT_TTL_MS;
    expect(grants.live("a")).toBe(false);
    expect(grants.state("a")).toEqual({ state: "expired" });
    grants.ask("b", 1);
    grants.allow("b");
    grants.refuse("b");
    expect(grants.live("b")).toBe(false);
    expect(grants.state("b")).toEqual({ state: "refused" });
    grants.ask("c", 1);
    grants.allow("c");
    grants.end("c");
    expect(grants.state("c")).toEqual({ state: "none" });
  });
});
