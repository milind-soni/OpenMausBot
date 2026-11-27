import { describe, expect, it } from "vitest";

import { newRoomName, newRoomResponder, ROOM_NAME_MAX } from "./new-room.ts";

describe("a new room's defaults", () => {
  it("names the room after its bots", () => {
    expect(newRoomName(["Otto"])).toBe("Otto");
    expect(newRoomName(["Otto", "Juniper"])).toBe("Otto & Juniper");
    expect(newRoomName(["Otto", "Juniper", "Pepper"])).toBe("Otto, Juniper & Pepper");
    expect(newRoomName(["Otto", "Juniper", "Pepper", "Miso", "Leg"])).toBe("Otto, Juniper, Pepper +2");
  });

  it("numbers a name another room already has", () => {
    expect(newRoomName(["Otto", "Juniper"], ["Otto & Juniper"])).toBe("Otto & Juniper 2");
    expect(newRoomName(["Otto", "Juniper"], ["Otto & Juniper", "Otto & Juniper 2"])).toBe("Otto & Juniper 3");
  });

  it("stays within the server's limit, on one line", () => {
    const long = Array.from({ length: 3 }, (_, i) => `${"Very long bot name ".repeat(3)}${i}`);
    const name = newRoomName(long, [newRoomName(long)]);
    expect(name.length).toBeLessThanOrEqual(ROOM_NAME_MAX);
    expect(newRoomName(["A\nB", "C"])).toBe("A B & C");
  });

  it("lets the first plain message get an answer without an @mention", () => {
    expect(newRoomResponder(["otto"], true)).toEqual({ kind: "member", botId: "otto" });
    expect(newRoomResponder(["otto", "juniper"], false)).toEqual({ kind: "member", botId: "otto" });
    expect(newRoomResponder(["otto", "juniper"], true)).toEqual({ kind: "auto", fallbackBotId: "otto" });
  });
});
