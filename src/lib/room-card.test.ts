import { beforeEach, describe, expect, it } from "vitest";
import type { CloudRoom, CloudUsage } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";
import { roomCardView, roomCauseText } from "@/lib/room-card";

const usage: CloudUsage = { tier: "starter", resetsAt: Date.UTC(2026, 10, 1), meters: [], upgrades: [{ tier: "pro", amount: 4900 }, { tier: "max", amount: 9900 }] };
const room = (over: Partial<CloudRoom> = {}): CloudRoom => ({ id: "offer-1", cause: { kind: "memory", waits: 3, waitMinutes: 6, stopped: 0 },
  plan: { tier: "pro", amount: 4900, memoryMb: 4096, fromMemoryMb: 2048, diskGb: 100, fromDiskGb: 10 }, ...over });
const view = (over: Partial<Parameters<typeof roomCardView>[0]> = {}) => roomCardView({ room: room(), usage, busy: false, hidden: null, usageCardShown: false, ...over });

beforeEach(() => setLocale("en"));

describe("what the card says ran short", () => {
  it("counts the day's waits and stops in plain words", () => {
    const memory = (cause: Partial<Extract<CloudRoom["cause"], { kind: "memory" }>>) => roomCauseText({ kind: "memory", waits: 0, waitMinutes: 0, stopped: 0, ...cause });
    expect(memory({ waits: 3, waitMinutes: 6 })).toBe("3 tasks waited 6 minutes for memory today.");
    expect(memory({ waits: 1, waitMinutes: 1 })).toBe("1 task waited 1 minute for memory today.");
    expect(memory({ waits: 4 })).toBe("4 tasks had to wait for memory today.");
    expect(memory({ stopped: 1 })).toBe("1 task was stopped today to keep everything else running.");
    expect(memory({ waits: 2, waitMinutes: 3, stopped: 2 })).toBe("2 tasks waited 3 minutes for memory today. 2 tasks were stopped today to keep everything else running.");
    // A wait that began before the day still names a task.
    expect(memory({ waitMinutes: 4 })).toBe("1 task waited 4 minutes for memory today.");
    expect(roomCauseText({ kind: "disk", usedGb: 17.25, capGb: 20 })).toBe("17.3 GB of 20 GB used.");
  });
});

describe("the card", () => {
  it("names the plan that fixes it by what it gives, with its price this month or after a trial", () => {
    expect(view()).toEqual({ id: "offer-1", kind: "memory", title: "This Cloud is short on room", cause: "3 tasks waited 6 minutes for memory today.",
      offer: { tier: "pro", text: "Pro has twice the memory.", price: "$49 a month. Today you pay only for the rest of this month." }, tip: null });
    const max = { tier: "max" as const, amount: 9900, diskGb: 100, fromDiskGb: 10 };
    expect(view({ room: room({ plan: { ...max, memoryMb: 8192, fromMemoryMb: 2048 } }) })?.offer?.text).toBe("Max has 4 times the memory.");
    expect(view({ room: room({ plan: { ...max, memoryMb: 8192, fromMemoryMb: 3072 } }) })?.offer?.text).toBe("Max has 8 GB of memory.");
    expect(view({ room: room({ cause: { kind: "disk", usedGb: 9, capGb: 10 } }) })).toMatchObject({ kind: "disk", title: "This Cloud is almost out of space",
      cause: "9 GB of 10 GB used.", offer: { text: "Pro has room for 100 GB." } });
    expect(view({ usage: { ...usage, trialEndsAt: Date.UTC(2026, 10, 3) } })?.offer?.price).toBe("$49 a month once your trial ends. Nothing is charged today.");
  });

  it("gives the top plan a tip instead of an offer", () => {
    expect(view({ room: { id: "tip-1", cause: { kind: "memory", waits: 0, waitMinutes: 0, stopped: 2 }, tip: true } })).toEqual({ id: "tip-1", kind: "memory",
      title: "This Cloud is short on room", cause: "2 tasks were stopped today to keep everything else running.", offer: null,
      tip: "You're on the biggest plan. To give it more room, run fewer bots at once and close browsers you're not using." });
  });

  it("is never shown mid-turn, after Not now on this offer, beside the usage card, or without an offer", () => {
    expect(view({ busy: true })).toBeNull();
    // On a team's Cloud: only an offer about the team's own plan, never one about the person's own Cloud.
    expect(view({ teamHome: true })).toBeNull();
    expect(view({ teamHome: true, usage: { ...usage, tier: "team", upgrades: [] }, room: room({ plan: undefined, tip: true }) })?.tip).toContain("biggest plan");
    expect(view({ hidden: "offer-1" })).toBeNull();
    expect(view({ hidden: "an-older-offer" })).not.toBeNull();
    expect(view({ usageCardShown: true })).toBeNull();
    expect(view({ room: null })).toBeNull();
    // An offer whose plan the session's upgrades don't list could never go through.
    expect(view({ usage: { ...usage, upgrades: [{ tier: "max", amount: 9900 }] } })).toBeNull();
  });
});
