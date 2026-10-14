import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppState, Bot, Group } from "@/state/store";
import { canSendBugReports, errorText, openChatThreadId } from "./bug-report";

const bots = [{ id: "scout", threadId: "scout-thread" }, { id: "piper", threadId: "piper-thread" }] as Bot[];
const groups = [{ id: "room", threadId: "room-thread" }] as Group[];
const state = (patch: Partial<AppState>) => ({ activeView: "chat", selectedId: "piper", bots, groups, ...patch }) as AppState;

afterEach(() => vi.unstubAllGlobals());

describe("the conversation a report may include", () => {
  it("is the chat on screen: a bot's thread, a room's thread, or the first bot's when nothing is picked", () => {
    expect(openChatThreadId(state({}))).toBe("piper-thread");
    expect(openChatThreadId(state({ selectedId: "room" }))).toBe("room-thread");
    expect(openChatThreadId(state({ selectedId: "" }))).toBe("scout-thread");
  });

  it("is none away from the chat", () => {
    expect(openChatThreadId(state({ activeView: "routines" }))).toBeUndefined();
    expect(openChatThreadId(state({ bots: [], selectedId: "" }))).toBeUndefined();
  });
});

describe("where reports can be sent from", () => {
  it("is only a window whose bridge can send one", () => {
    vi.stubGlobal("window", {});
    expect(canSendBugReports()).toBe(false);
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    expect(canSendBugReports()).toBe(false);
    vi.stubGlobal("window", { ogb: { sendBugReport: async () => ({ ok: true, id: "br" }) } });
    expect(canSendBugReports()).toBe(true);
  });

  it("shows a main-process error without Electron's wrapper", () => {
    expect(errorText(new Error("Error invoking remote method 'desktop:send-bug-report': Error: desktop:send-bug-report is only available while using the local server")))
      .toBe("desktop:send-bug-report is only available while using the local server");
  });
});
