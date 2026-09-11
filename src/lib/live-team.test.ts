import { describe, expect, it } from "vitest";
import { studioPage, stationState } from "./live-team";
import { studioMotions } from "./live-team-motion";
import { readStudioPreferences, saveStudioPreferences } from "./live-team-preferences";
import type { StudioSnapshot } from "../../shared/live-team";
import type { Bot, InstanceInfo } from "@/state/store";
const snapshot = (): StudioSnapshot => ({ workspaceId: "one", serverTime: 100, revision: "1", room: "Work", rooms: [], stations: [], attention: { items: [], total: 0, offset: 0 }, handoffs: { items: [], total: 0, offset: 0 }, results: { items: [], total: 0, offset: 0 } });
describe("studio presentation", () => {
  it("keeps desk identity order and reaches every bot without shrinking the room", () => {
    const bots = Array.from({ length: 27 }, (_, i) => ({ id: `${i}`, name: `Bot ${i}` }));
    expect(studioPage(bots, "", 0, (b) => b.name).items).toEqual(bots.slice(0, 12));
    expect(studioPage(bots, "", 99, (b) => b.name)).toMatchObject({ items: bots.slice(24), page: 2, pages: 3, total: 27 });
    expect(studioPage(bots, " BOT 25 ", 0, (b) => b.name).items[0]?.id).toBe("25");
  });
  it("prioritizes off-page requests while retaining concurrent work", () => {
    const bot = { id: "b", modelSelection: { instanceId: "engine" } } as Bot;
    const station = { botId: "b", attentionCount: 1, threadCount: 2, threads: [{ threadId: "t", busy: true, title: "task", activity: "working" as const, queued: 2 }] };
    const instances = [{ instanceId: "engine", snapshot: { state: "available" } }] as InstanceInfo[];
    expect(stationState(bot, station, snapshot(), instances, false)).toBe("waiting");
    expect(stationState(bot, station, snapshot(), instances, true)).toBe("stale");
    expect(stationState(bot, { ...station, attentionCount: 0 }, snapshot(), instances, false)).toBe("working");
    expect(stationState(bot, undefined, snapshot(), [], false)).toBe("unavailable");
  });
  it("never replays hydration, reconnect, room changes, or history pagination", () => {
    const first = snapshot();
    const baseline = studioMotions(null, first);
    const next = { ...first, serverTime: 120, results: { items: [{ id: "r", botId: "b", threadId: "t", turnId: "u", finishedAt: 110, title: "done", status: "completed" as const }], total: 1, offset: 0 } };
    const arrived = studioMotions(baseline.state, next);
    expect(arrived.motions).toHaveLength(1);
    expect(studioMotions(arrived.state, next).motions).toEqual([]);
    expect(studioMotions(baseline.state, next, true).motions).toEqual([]);
    expect(studioMotions(baseline.state, { ...next, room: "Home" }).motions).toEqual([]);
    expect(studioMotions(baseline.state, { ...next, results: { ...next.results, offset: 50 } }).motions).toEqual([]);
    expect(studioMotions(baseline.state, { ...next, results: { ...next.results, items: [{ ...next.results.items[0], finishedAt: 90 }] } }).motions).toEqual([]);
  });
  it("caps a burst at two transfers and never celebrates a failed turn", () => {
    const first = snapshot();
    const state = studioMotions(null, first).state;
    const next = { ...first, serverTime: 200, handoffs: { items: Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, sourceBotId: "a", targetBotId: "b", sourceThreadId: "s", at: 150, state: "running" as const })), total: 5, offset: 0 }, results: { items: [{ id: "fail", botId: "b", threadId: "t", turnId: "u", finishedAt: 150, title: "failed", status: "failed" as const }], total: 1, offset: 0 } };
    const burst = studioMotions(state, next);
    expect(burst.motions).toHaveLength(2);
    expect(burst.overflow).toBe(3);
    expect(studioMotions(burst.state, next).motions).toEqual([]);
  });
  it("scopes preferences by workspace and tolerates denied or corrupt storage", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    saveStudioPreferences("a", { presentation: "studio", room: "Work", calm: true }, storage);
    expect(readStudioPreferences("a", storage)).toEqual({ presentation: "studio", room: "Work", calm: true });
    expect(readStudioPreferences("b", storage).presentation).toBe("map");
    expect(readStudioPreferences("a", { getItem: () => "garbage" }).presentation).toBe("map");
    expect(() => saveStudioPreferences("a", { presentation: "studio", room: "", calm: false }, { setItem: () => { throw Error("denied"); } })).not.toThrow();
  });
});
