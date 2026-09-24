import { describe, expect, it } from "vitest";
import { pendingPermissions, PermissionAutoApproveClock, type PendingPermission, type PermissionCountdown } from "./permissionAutoApprove";
import type { AppState, Bot } from "@/state/store";

const permission: PendingPermission = { key: "bot:message", botId: "bot", messageId: "message", requestId: "request" };

function setup() {
  let now = 0;
  let view: PermissionCountdown = {};
  const fired: PendingPermission[] = [];
  const clock = new PermissionAutoApproveClock((card) => fired.push(card), (next) => { view = next; }, () => now);
  return { clock, fired, get view() { return view; }, setTime(value: number) { now = value; } };
}

describe("permission idle auto-approval", () => {
  it("fires once after ten idle seconds and shows a countdown", () => {
    const rig = setup();
    rig.clock.sync([permission]);
    expect(rig.view[permission.key]).toEqual({ remaining: 10 });
    rig.setTime(3_000);
    rig.clock.tick();
    expect(rig.view[permission.key]).toEqual({ remaining: 7 });
    rig.setTime(9_999);
    rig.clock.tick();
    expect(rig.fired).toEqual([]);
    rig.setTime(10_000);
    rig.clock.tick();
    rig.clock.tick();
    expect(rig.fired).toEqual([permission]);
    expect(rig.view[permission.key]).toEqual({ firing: true });
  });

  it("restarts after activity and stops when cancelled", () => {
    const rig = setup();
    rig.clock.sync([permission]);
    rig.setTime(7_000);
    rig.clock.activity();
    rig.setTime(10_000);
    rig.clock.tick();
    expect(rig.view[permission.key]).toEqual({ remaining: 7 });
    rig.clock.cancel(permission.key);
    rig.setTime(30_000);
    rig.clock.tick();
    expect(rig.fired).toEqual([]);
    expect(rig.view[permission.key]).toEqual({ cancelled: true });
  });

  it("never selects question cards, even when their options say Allow and Deny", () => {
    const bot = {
      id: "bot", threadId: "thread", messages: [{ id: "question", card: {
        title: "Question", subtitle: "Proceed?", options: ["Allow", "Deny"], requestId: "question-request", requestType: "question",
      } }],
    } as Bot;
    const rig = setup();
    rig.clock.sync(pendingPermissions({ bots: [bot], groups: [] } as Pick<AppState, "bots" | "groups">));
    rig.setTime(20_000);
    rig.clock.tick();
    expect(rig.fired).toEqual([]);
    expect(rig.view).toEqual({});
  });

  it("drops permission cards after Allow, Deny, or Dismiss", () => {
    const card = { title: "Approval needed", subtitle: "Run?", options: ["Allow", "Deny"], requestId: "request", requestType: "permission" as const };
    const bot = { id: "bot", threadId: "thread", messages: [
      { id: "allowed", card: { ...card, answered: "Allow" } },
      { id: "denied", card: { ...card, answered: "Deny" } },
      { id: "dismissed", card: { ...card, dismissed: true } },
    ] } as Bot;
    expect(pendingPermissions({ bots: [bot], groups: [] })).toEqual([]);
  });

  it("does not fire while disabled and starts a fresh delay when enabled", () => {
    const rig = setup();
    rig.clock.configure(false, 10);
    rig.clock.sync([permission]);
    rig.setTime(30_000);
    rig.clock.tick();
    expect(rig.fired).toEqual([]);
    rig.clock.configure(true, 10);
    expect(rig.view[permission.key]).toEqual({ remaining: 10 });
    rig.setTime(40_000);
    rig.clock.tick();
    expect(rig.fired).toEqual([permission]);
  });
});
