import { afterEach, describe, expect, it } from "vitest";

import { createGoalCards } from "./host/goal-cards.ts";
import { sentRow, teammateResultRow } from "./host/handoff-sent.ts";
import { briefCrossingLabel, recallCrossingLabel } from "./recall-disclosure.ts";
import "./server-line-packs.ts";
import { setConversationLanguage } from "./server-lines.ts";
import type { Message } from "./store.ts";
import { queuedBehindPersonText, settledWaitingChip } from "./waiting-on-person.ts";

const ada = { id: "ada", name: "Ada", color: "blue" as const };
const biber = { id: "biber", name: "Biber", color: "red" as const };

describe("what a conversation shows about a teammate's work", () => {
  afterEach(() => setConversationLanguage(() => undefined));

  it("says a hand-off went out in the language of the sender's conversation", () => {
    expect(sentRow({ sender: ada, recipient: biber, threadId: "t", via: "direct", language: "de" }).tool?.name).toBe("An Biber gesendet");
    expect(sentRow({ sender: ada, recipient: biber, threadId: "t", via: "direct", room: { id: "g", name: "Launch", here: true }, language: "de" }).tool?.name)
      .toBe("Direkt an Biber gesendet: er ist nicht in diesem Raum.");
    expect(sentRow({ sender: ada, recipient: biber, threadId: "t", via: "lane", room: { id: "g", name: "Launch", here: false } }).tool?.name).toBe("Sent to Biber · Launch");
    expect(sentRow({ sender: ada, recipient: biber, threadId: "t", via: "direct", language: "de" }).threadRef?.title).toBe("Arbeit für ein Teammitglied");
  });

  it("says how the work came back", () => {
    expect(teammateResultRow("de", { status: "completed", result: "Done", groupId: "g" }, "Biber", undefined, "Launch")).toBe("Biber hat geantwortet · Launch");
    expect(teammateResultRow("de", { status: "failed", result: "boom\nmore" }, "Biber", undefined, undefined)).toBe("Biber: fehlgeschlagen: boom");
    expect(teammateResultRow("de", { status: "completed", result: "" }, undefined, "team access changed", undefined)).toBe("Ergebnis zurückgehalten: team access changed");
    expect(teammateResultRow(undefined, { status: "cancelled", result: "stopped" }, undefined, undefined, undefined)).toBe("Teammate — cancelled: stopped");
  });

  it("says what came of a teammate's question or approval, and what waits behind the person", () => {
    expect(settledWaitingChip("Biber", "answer", "allow", "user", "de")).toEqual({ name: "@Biber hat deine Antwort bekommen", ok: true });
    expect(settledWaitingChip("Biber", "approval", "allow", "timeout", "de").name).toBe("Niemand hat die Freigabe von @Biber rechtzeitig erteilt, dieser Schritt lief nicht");
    expect(settledWaitingChip("Biber", "approval", "deny", "user")).toEqual({ name: "@Biber's request was denied", ok: false });
    expect(queuedBehindPersonText("Biber", "question", "Release", "de")).toBe("Für @Biber hinter deiner Antwort in „Release“ eingereiht");
    expect(recallCrossingLabel("Biber", 1, "de")).toBe("Biber hat 1 Nachricht aus seinem privaten Chat mit dir abgerufen");
    expect(briefCrossingLabel("Biber", 3)).toBe("Biber's recent-work brief covers 3 private chats with you");
  });

  it("writes a room goal's card in the room's language", () => {
    setConversationLanguage((threadId) => (threadId === "room" ? "de" : undefined));
    const lines: Message[] = [];
    const store = {
      appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => { const full = { id: `m${lines.length + 1}`, at: 1, ...message } as Message; lines.push(full); return full; },
      bot: () => null,
      messagesFor: () => lines,
      patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => { const line = lines.find((one) => one.id === id)!; Object.assign(line, patch); return line; },
    };
    const goals = createGoalCards({ store: store as never, routines: () => null, notify: () => {}, routineSourceOwner: () => null, routineSourceThread: () => null });
    const run = goals.start("room", biber, "Ship the release", "run-1");
    expect(lines[0]!.text).toBe("Ziel in Arbeit: Biber koordiniert dieses Ziel.");
    expect(lines[0]!.goalRun?.detail).toBe("Biber koordiniert dieses Ziel.");
    goals.finish("room", run, "needs-input", "Welche Version?", () => true);
    expect(lines[0]!.text).toBe("Ziel braucht deine Eingabe: Welche Version?");
  });
});
