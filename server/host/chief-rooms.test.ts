import { describe, expect, it } from "vitest";

import type { GroupDefaultResponder } from "../../shared/wire.ts";
import type { BotRecord, GroupRecord } from "../store.ts";
import { chiefAbsentFrom, createChiefRooms, type ChiefRoomsDeps } from "./chief-rooms.ts";

const bot = (id: string, chief = false, section = "Ops") => ({ id, name: id.toUpperCase(), section, chiefOfStaff: chief }) as unknown as BotRecord;
const room = (id: string, memberIds: string[], defaultResponder: GroupDefaultResponder, extra: Partial<GroupRecord> = {}) =>
  ({ id, threadId: `${id}-thread`, section: "Ops", memberIds, defaultResponder, ...extra }) as unknown as GroupRecord;

function world(groups: GroupRecord[], refuse: ReadonlySet<string> = new Set()) {
  const lines: Array<{ threadId: string; name: string | undefined }> = [];
  const published: string[] = [];
  const updates: Array<{ id: string; patch: Parameters<ChiefRoomsDeps["updateRoom"]>[1] }> = [];
  const deps: ChiefRoomsDeps = {
    store: { groups, appendMessage: ((threadId: string, message: { tool?: { name?: string } }) => { lines.push({ threadId, name: message.tool?.name }); }) as never },
    updateRoom: (id, patch) => {
      if (refuse.has(id)) throw new Error("this channel is working or waiting on you");
      updates.push({ id, patch });
      const group = groups.find((one) => one.id === id)!;
      Object.assign(group, patch);
      return group;
    },
    published: (group) => { published.push(group.id); },
  };
  return { rooms: createChiefRooms(deps), lines, published, updates };
}

describe("rooms follow their Chief of Staff", () => {
  const former = bot("old");
  const chief = bot("new", true);

  it("hands a room the old Chief led to the new one, added once, with one line saying so", () => {
    const led = room("led", ["old", "mira"], { kind: "member", botId: "old" });
    const auto = room("auto", ["old", "new"], { kind: "auto", fallbackBotId: "old" });
    const w = world([led, auto]);
    w.rooms.moved([former, chief]);
    expect(led).toMatchObject({ memberIds: ["old", "mira", "new"], defaultResponder: { kind: "member", botId: "new" } });
    expect(auto).toMatchObject({ memberIds: ["old", "new"], defaultResponder: { kind: "auto", fallbackBotId: "new" } });
    expect(w.lines.map((line) => line.threadId)).toEqual(["led-thread", "auto-thread"]);
    expect(w.lines[0]!.name).toBe("notice: NEW is the Chief of Staff now, so it leads this room in place of OLD.");
  });

  it("leaves a room the old Chief did not lead alone, and a one-to-one channel out of it", () => {
    const other = room("other", ["old", "mira"], { kind: "member", botId: "mira" });
    const mentions = room("mentions", ["old"], { kind: "mentions" });
    const dm = room("dm", ["old", "mira"], { kind: "member", botId: "old" }, { dm: true });
    const w = world([other, mentions, dm]);
    w.rooms.moved([former, chief]);
    expect(w.updates).toEqual([]);
    expect(w.lines).toEqual([]);
    expect(w.published).toEqual(["other", "mentions"]);
  });

  it("skips a room that may not change now, and still publishes it so its line shows", () => {
    const busy = room("busy", ["old"], { kind: "member", botId: "old" });
    const w = world([busy], new Set(["busy"]));
    w.rooms.moved([former, chief]);
    expect(busy.defaultResponder).toEqual({ kind: "member", botId: "old" });
    expect(w.lines).toEqual([]);
    expect(w.published).toEqual(["busy"]);
    expect(chiefAbsentFrom(busy, [former, chief])).toEqual({ botId: "new", name: "NEW" });
  });

  it("does nothing when no Chief changed, and retargets nothing when a department loses its Chief", () => {
    const led = room("led", ["old"], { kind: "member", botId: "old" });
    const w = world([led]);
    w.rooms.moved([]);
    expect(w.published).toEqual([]);
    w.rooms.moved([former]);
    expect(w.updates).toEqual([]);
    expect(w.published).toEqual(["led"]);
  });
});

describe("a room without its department's Chief", () => {
  const chief = bot("chief", true);

  it("names the Chief only when it is absent from its own department's room", () => {
    expect(chiefAbsentFrom(room("r", ["mira"], { kind: "mentions" }), [chief])).toEqual({ botId: "chief", name: "CHIEF" });
    expect(chiefAbsentFrom(room("r", ["chief"], { kind: "mentions" }), [chief])).toBeUndefined();
    expect(chiefAbsentFrom(room("r", ["mira"], { kind: "mentions" }, { section: "Growth" }), [chief])).toBeUndefined();
    expect(chiefAbsentFrom(room("r", ["mira"], { kind: "mentions" }, { dm: true }), [chief])).toBeUndefined();
    expect(chiefAbsentFrom(room("r", ["mira"], { kind: "mentions" }), [{ ...chief, hidden: true } as BotRecord])).toBeUndefined();
  });
});
