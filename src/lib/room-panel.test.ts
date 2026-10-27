// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppState } from "@/state/store";
import { closeRoomPanel, openRoomPanel, simpleRoomHeader, useRoomPanel, useRoomPanelShown } from "./room-panel";

type Shell = Pick<AppState, "selectedId" | "activeView" | "settingsOpen">;

let root: Root;
let container: HTMLDivElement;
const seen = { open: null as string | null, shown: false };

function Probe({ group, state, simple }: { group?: { id: string }; state: Shell; simple: boolean }) {
  seen.open = useRoomPanel();
  seen.shown = useRoomPanelShown({ group, state, simple });
  return null;
}
const room = { id: "desk" };
const inRoom: Shell = { selectedId: "desk", activeView: "chat", settingsOpen: false };
const render = (state: Shell, simple = true, group: { id: string } | null = room) =>
  flushSync(() => root.render(createElement(Probe, { group: group ?? undefined, state, simple })));
const open = () => flushSync(() => openRoomPanel("desk"));

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  closeRoomPanel();
});

describe("which rooms get the calm header", () => {
  const room = { dm: false };
  it("is a normal room on this desktop in Simple mode", () => {
    expect(simpleRoomHeader({ advanced: false, remoteClient: false, group: room, setupPending: false })).toBe(true);
  });

  it("keeps today's header in Advanced mode, on a remote client, in a DM and while the room is being set up", () => {
    expect(simpleRoomHeader({ advanced: true, remoteClient: false, group: room, setupPending: false })).toBe(false);
    expect(simpleRoomHeader({ advanced: false, remoteClient: true, group: room, setupPending: false })).toBe(false);
    expect(simpleRoomHeader({ advanced: false, remoteClient: false, group: { dm: true }, setupPending: false })).toBe(false);
    expect(simpleRoomHeader({ advanced: false, remoteClient: false, group: room, setupPending: true })).toBe(false);
  });
});

describe("the Room panel's open state", () => {
  it("opens for one room and hands focus back to its opener when the person closes it", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    render(inRoom);
    flushSync(() => openRoomPanel("desk", opener));
    expect([seen.open, seen.shown]).toEqual(["desk", true]);
    flushSync(() => closeRoomPanel({ refocus: true }));
    expect([seen.open, seen.shown]).toEqual([null, false]);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("leaves focus alone on a close nobody asked for", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    render(inRoom);
    flushSync(() => openRoomPanel("desk", opener));
    flushSync(() => closeRoomPanel());
    expect(document.activeElement).not.toBe(opener);
    opener.remove();
  });

  it("closes when another room opens, and stays closed on the way back", () => {
    render(inRoom);
    open();
    expect(seen.shown).toBe(true);
    render({ ...inRoom, selectedId: "standup" }, true, { id: "standup" });
    expect([seen.open, seen.shown]).toEqual([null, false]);
    render(inRoom);
    expect(seen.shown).toBe(false);
  });

  it("closes when a bot panel opens, another view opens or the mode changes", () => {
    render(inRoom);
    open();
    render({ ...inRoom, settingsOpen: true });
    expect(seen.open).toBeNull();

    render(inRoom);
    open();
    render({ ...inRoom, activeView: "routines" });
    expect(seen.open).toBeNull();

    render(inRoom);
    open();
    render(inRoom, false);
    expect([seen.open, seen.shown]).toEqual([null, false]);
  });

  it("shows only for the room it was opened for, and never outside Simple mode", () => {
    render(inRoom, true, { id: "standup" });
    open();
    expect(seen.shown).toBe(false);
    render(inRoom, true, null);
    expect(seen.shown).toBe(false);
    render(inRoom, false);
    open();
    expect([seen.open, seen.shown]).toEqual(["desk", false]);
  });
});
