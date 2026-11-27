import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseConfigPatch, parseStoredConfig } from "./config.ts";
import { roomContextSettings, roomSessionsEnabled } from "./room-context-settings.ts";

describe("room context settings", () => {
  it("keeps room sessions off unless the file switches them on", () => {
    expect(roomSessionsEnabled(undefined, {})).toBe(false);
    expect(roomSessionsEnabled({}, {})).toBe(false);
    expect(roomSessionsEnabled({ roomSessions: false }, {})).toBe(false);
    expect(roomSessionsEnabled({ roomSessions: true }, {})).toBe(true);
  });

  it("lets OMB_ROOM_SESSIONS win over the file when it is 1 or 0, and only then", () => {
    expect(roomSessionsEnabled(undefined, { OMB_ROOM_SESSIONS: "1" })).toBe(true);
    expect(roomSessionsEnabled({ roomSessions: false }, { OMB_ROOM_SESSIONS: "1" })).toBe(true);
    expect(roomSessionsEnabled({ roomSessions: true }, { OMB_ROOM_SESSIONS: "0" })).toBe(false);
    expect(roomSessionsEnabled({ roomSessions: true }, { OMB_ROOM_SESSIONS: " 0 " })).toBe(false);
    for (const other of ["", "true", "yes", "2", "on"]) {
      expect(roomSessionsEnabled({ roomSessions: true }, { OMB_ROOM_SESSIONS: other })).toBe(true);
      expect(roomSessionsEnabled({ roomSessions: false }, { OMB_ROOM_SESSIONS: other })).toBe(false);
      expect(roomSessionsEnabled(undefined, { OMB_ROOM_SESSIONS: other })).toBe(false);
    }
  });

  it("carries roomCompactAt with the bounds it had in config.ts", () => {
    const shape = z.object(roomContextSettings);
    expect(shape.parse({ roomCompactAt: 0.9 })).toEqual({ roomCompactAt: 0.9 });
    expect(shape.parse({ roomCompactAt: 10_000_000 })).toEqual({ roomCompactAt: 10_000_000 });
    for (const value of [0, -0.5, 10_000_001, "0.9"]) expect(() => shape.parse({ roomCompactAt: value })).toThrow();
    expect(shape.parse({})).toEqual({});
  });

  it("is part of config.json's context group, stored and patched", () => {
    const context = { autoCompact: true, compactAt: 0.7, roomCompactAt: 0.5, roomSessions: true };
    expect(parseStoredConfig({ context })).toEqual({ context });
    expect(parseConfigPatch({ context: { roomSessions: false } })).toEqual({ context: { roomSessions: false } });
    expect(() => parseConfigPatch({ context: { roomSessions: "yes" } })).toThrow();
    expect(() => parseConfigPatch({ context: { roomCompactAt: 0 } })).toThrow();
  });
});
