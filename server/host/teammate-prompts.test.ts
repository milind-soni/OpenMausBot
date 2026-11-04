import { describe, expect, it, vi } from "vitest";

import type { BotRecord } from "../store.ts";
import { LONG_WAIT_MS, waitedWords } from "./long-waits.ts";
import { createTeammatePrompts, type TeammatePromptDeps } from "./teammate-prompts.ts";

vi.mock("../peer-roster.ts", () => ({ canManage: () => true }));

const chief = { id: "chief", name: "Clive", chiefOfStaff: true } as BotRecord;
const teammate = { id: "mira", name: "Mira" } as BotRecord;

const NOW = 10 * 24 * 60 * 60_000;

function questions(fullAccess: boolean, since = NOW - 60_000, now = NOW): string {
  const deps = {
    now: () => now,
    store: { bots: [chief, teammate], bot: () => teammate },
    isUnattended: () => false,
    startedOutside: () => false,
    guestDriven: () => false,
    confined: () => false,
    fullAccess: () => fullAccess,
    readableFrom: () => () => true,
    waitingForPerson: () => [{ bot: "Mira", threadId: "t1", thread: "Pricing", question: "Keep the old page?", since }],
  } as unknown as TeammatePromptDeps;
  return createTeammatePrompts(deps).questions(chief, "job");
}

describe("what a Chief is told about its teammates' questions", () => {
  it("answers on its own certainty only at Full access", () => {
    expect(questions(true)).toContain("you know the answer for certain");
  });

  it("below Full access answers only when the person gave the answer or asked it to", () => {
    const told = questions(false);
    expect(told).toContain("When the person gives you an answer or asks you to answer one, send it");
    expect(told).not.toContain("for certain");
  });

  it("a question nobody answered for a day is said in one plain line the next time the person talks, never a card", () => {
    const fresh = questions(true, NOW - LONG_WAIT_MS + 1);
    expect(fresh).not.toContain("waited");
    const yesterday = questions(true, NOW - LONG_WAIT_MS);
    expect(yesterday).toContain('"waited":"since yesterday"');
    expect(yesterday).toContain("Unless you already said so in this conversation, say in one plain line of your reply");
    expect(yesterday).toContain("not a card or a new question");
    expect(questions(true, NOW - 3 * LONG_WAIT_MS - 1)).toContain('"waited":"for 3 days"');
    expect(waitedWords(NOW - 2 * LONG_WAIT_MS, NOW)).toBe("for 2 days");
  });

  it("a webhook, routine, guest or read-and-draft turn has no person behind it, whatever the bot's level", () => {
    const prompts = (over: Partial<TeammatePromptDeps>) => createTeammatePrompts({ store: { bots: [], bot: () => undefined }, isUnattended: () => false, startedOutside: () => false,
      guestDriven: () => false, confined: () => false, ...over } as unknown as TeammatePromptDeps);
    expect(prompts({}).personBehind("own", "inbox")).toBe(true);
    for (const over of [{ isUnattended: () => true }, { startedOutside: () => true }, { guestDriven: () => true }, { confined: () => true }]) {
      expect(prompts(over).personBehind("own", "inbox")).toBe(false);
    }
  });

  it("a teammate's words stay in the JSON list, never loose in the sentence that tells the Chief what to do", () => {
    const told = questions(true, NOW - 2 * LONG_WAIT_MS);
    expect(told.split("Keep the old page?")).toHaveLength(2);
    expect(told.slice(told.indexOf("]. "))).not.toContain("Keep the old page?");
  });
});
