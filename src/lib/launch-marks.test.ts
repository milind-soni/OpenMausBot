import { describe, expect, it } from "vitest";

import { GIVE_UP_AFTER_MS, pageHostKind, SETTLE_AFTER_CHAT_MS, startLaunchMarks, type LaunchMarkDeps, type PageLaunchPart } from "./launch-marks";

const OWN = "http://127.0.0.1:8799";

function page(overrides: Partial<LaunchMarkDeps> = {}) {
  const state = { clock: 0, present: new Set<string>(), changed: () => {}, watching: false, timers: [] as Array<{ run: () => void; ms: number }>, posts: [] as PageLaunchPart[] };
  const entries: Record<string, Array<{ name: string; startTime: number; duration: number; responseStart?: number; responseEnd?: number }>> = {
    navigation: [{ name: `${OWN}/`, startTime: 0, duration: 60, responseStart: 28 }],
    paint: [{ name: "first-paint", startTime: 150, duration: 0 }, { name: "first-contentful-paint", startTime: 170, duration: 0 }],
    longtask: [{ name: "self", startTime: 176, duration: 119 }, { name: "self", startTime: 400, duration: 120 }],
    resource: [
      { name: `${OWN}/api/bots?messages=200`, startTime: 170, duration: 6, responseEnd: 176 },
      { name: "https://www.google.com/s2/favicons?domain=intranet.acme.test&sz=64", startTime: 128, duration: 19, responseEnd: 147 },
      { name: "https://accounts.openmausbot.com/session?token=abc", startTime: 200, duration: 80, responseEnd: 280 },
      { name: "https://omb-u-1.fly.dev/api/health", startTime: 900, duration: 10, responseEnd: 910 },
      { name: "data:image/png;base64,AAAA", startTime: 10, duration: 1, responseEnd: 11 },
    ],
  };
  startLaunchMarks({
    has: (selector) => state.present.has(selector),
    watch(changed) { state.changed = changed; state.watching = true; return () => { state.watching = false; }; },
    now: () => state.clock, timeOrigin: 1_800_000_000_860, origin: OWN,
    entries: (type) => entries[type] ?? [],
    later: (run, ms) => { state.timers.push({ run, ms }); },
    post: (part) => { state.posts.push(part); },
    ...overrides,
  });
  return state;
}

describe("the page's launch marks", () => {
  it("are posted once, a moment after the chat is drawn: times and counts by kind of host, never an address", () => {
    const state = page();
    expect(state.timers.map((timer) => timer.ms)).toEqual([GIVE_UP_AFTER_MS]);
    state.clock = 335;
    state.present.add("[data-sidebar-bot-row]");
    state.changed();
    expect(state.watching).toBe(true);
    state.clock = 340;
    state.present.add("[data-mid]");
    state.changed();
    expect(state.watching).toBe(false);
    expect(state.posts).toEqual([]);
    expect(state.timers.map((timer) => timer.ms)).toEqual([GIVE_UP_AFTER_MS, SETTLE_AFTER_CHAT_MS]);
    state.clock = 1_840;
    state.timers[1]!.run();
    state.timers[0]!.run();
    expect(state.posts).toEqual([{
      from: "page", timeOrigin: 1_800_000_000_860,
      marks: { sidebarDrawn: 335, chatDrawn: 340, pageResponse: 28, firstPaint: 170, lastLongTaskEnd: 520 },
      net: { other: { n: 1, ms: 19 }, accounts: { n: 1, ms: 80 } },
    }]);
    expect(JSON.stringify(state.posts)).not.toMatch(/acme|token|google|fly\.dev|https?:/);
  });

  it("go without a chat mark when no chat is drawn in time, and a chat already drawn is seen at once", () => {
    const none = page();
    none.clock = GIVE_UP_AFTER_MS;
    none.timers[0]!.run();
    expect(none.watching).toBe(false);
    expect(none.posts).toHaveLength(1);
    expect(none.posts[0]!.marks.chatDrawn).toBeUndefined();
    expect(none.posts[0]!.net).toEqual({ other: { n: 1, ms: 19 }, accounts: { n: 1, ms: 80 }, cloud: { n: 1, ms: 10 } });

    const state = { present: true };
    const drawn = page({ has: () => state.present });
    expect(drawn.watching).toBe(false);
    expect(drawn.timers.map((timer) => timer.ms)).toEqual([GIVE_UP_AFTER_MS, SETTLE_AFTER_CHAT_MS]);
  });

  it("cost nothing when the page cannot read its own timings or cannot post", () => {
    const broken = page({ entries: () => { throw new Error("no timings"); } });
    broken.timers[0]!.run();
    expect(broken.posts).toEqual([]);
    const refused = page({ post: () => { throw new Error("offline"); } });
    expect(() => refused.timers[0]!.run()).not.toThrow();
  });
});

describe("pageHostKind", () => {
  it("names a kind of host, and nothing for the page's own server", () => {
    expect(pageHostKind("/api/bots", OWN)).toBeNull();
    expect(pageHostKind("http://localhost:5173/x", OWN)).toBeNull();
    expect(pageHostKind("blob:http://127.0.0.1:8799/abc", OWN)).toBeNull();
    expect(pageHostKind("https://accounts.openmausbot.com/x", OWN)).toBe("accounts");
    expect(pageHostKind("https://c-opaque.openmausbot.com/x", OWN)).toBe("cloud");
    expect(pageHostKind("https://objects.githubusercontent.com/x", OWN)).toBe("updates");
    expect(pageHostKind("https://intranet.acme.test/q?token=abc", OWN)).toBe("other");
  });
});
