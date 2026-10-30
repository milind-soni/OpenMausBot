import { describe, expect, it } from "vitest";
import { composeExecutionPrompt } from "./routine-execution.ts";
import { ownersOwnLine, stampOwner } from "./cloud-owner-lines.ts";
import type { Message } from "./store.ts";

const OWNER = { person: "p_owner0000000000000000", name: "Amit" };
const line = (extra: Partial<Message> = {}): Message => ({ id: "m1", at: 1, role: "user", kind: "text", text: "Book the flight.", ...extra });

describe("a line its owner wrote on the computer it came from", () => {
  it("is a user line that names nobody, typed, spoken or steered in that computer's own window", () => {
    for (const mine of [line(), line({ via: "call" }), line({ steered: true }), line({ queued: true })]) expect(ownersOwnLine(mine), JSON.stringify(mine)).toBe(true);
  });

  it("is never another's words or an automation's, however it arrives", () => {
    const routine = composeExecutionPrompt({ name: "Morning brief", trigger: "schedule", runOn: "maus" }, "Read my inbox.", []);
    const byHand = composeExecutionPrompt({ name: "Morning brief", trigger: "manual", runOn: "maus" }, "Read my inbox.", []);
    const hook = composeExecutionPrompt({ name: "Inbox", trigger: "webhook", runOn: "maus" }, "[USER-CONFIGURED WEBHOOK INSTRUCTIONS]\nHandle it.\n[/USER-CONFIGURED WEBHOOK INSTRUCTIONS]\n\n[UNTRUSTED WEBHOOK EVENT DATA]\n{}\n[/UNTRUSTED WEBHOOK EVENT DATA]", []);
    const event = "[USER-CONFIGURED TRIGGER INSTRUCTIONS]\nDraft a reply.\n[/USER-CONFIGURED TRIGGER INSTRUCTIONS]\n[UNTRUSTED APP EVENT DATA]\n{}\n[/UNTRUSTED APP EVENT DATA]";
    for (const other of [
      line({ sender: { name: "Guest", id: "p_guest" } }),
      line({ peerAsk: { botId: "chief", name: "Chief" } }),
      line({ aside: true }),
      line({ relayed: true }),
      line({ via: "api" as never }),
      line({ role: "bot" }),
      line({ role: "bot", webhookPost: true }),
      line({ text: routine }), line({ text: byHand }), line({ text: hook }), line({ text: event }),
    ]) expect(ownersOwnLine(other), JSON.stringify(other).slice(0, 120)).toBe(false);
  });

  it("is stamped with My Cloud's owner, and so is a card answered in that window; nothing else changes", () => {
    const answered = { title: "Run it?", subtitle: "", options: ["Allow", "Deny"], requestId: "r1", answered: "Allow" };
    const rows: Message[] = [
      line({ id: "a" }),
      line({ id: "b", peerAsk: { botId: "chief", name: "Chief" } }),
      { id: "c", at: 2, role: "bot", kind: "options", card: { ...answered, answeredBy: { kind: "loopback" } } },
      { id: "d", at: 3, role: "bot", kind: "options", card: { ...answered, requestId: "r2" } },
      { id: "e", at: 4, role: "bot", kind: "options", card: { ...answered, requestId: "r3", answeredBy: { kind: "worker" } } },
      { id: "f", at: 5, role: "bot", kind: "options", card: { ...answered, requestId: "r4", answeredBy: { kind: "session", name: "Phone" } } },
      { id: "g", at: 6, role: "bot", kind: "options", card: { ...answered, requestId: "r5", answered: undefined, dismissed: true } },
      { id: "h", at: 7, role: "bot", kind: "options", card: { ...answered, requestId: "r6", answeredBy: { kind: "loopback", via: "call" } } },
    ];
    const stamped = stampOwner(rows, OWNER);
    expect(stamped.map((row) => row.sender?.id ?? null)).toEqual([OWNER.person, null, null, null, null, null, null, null]);
    expect(stamped[0]!.sender).toEqual({ name: "Amit", id: OWNER.person });
    expect(stamped.map((row) => row.card?.answeredBy ?? null)).toEqual([null, null,
      { kind: "session", name: "Amit", person: OWNER.person },
      { kind: "session", name: "Amit", person: OWNER.person },
      { kind: "worker" },
      { kind: "session", name: "Phone" },
      null,
      { kind: "session", name: "Amit", person: OWNER.person, via: "call" }]);
    expect(stamped.map(({ sender: _sender, card, ...rest }) => ({ ...rest, card: card && { ...card, answeredBy: undefined } })))
      .toEqual(rows.map(({ sender: _sender, card, ...rest }) => ({ ...rest, card: card && { ...card, answeredBy: undefined } })));
    expect(rows[0]!.sender, "the rows given are left as they were").toBeUndefined();
  });
});
