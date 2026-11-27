// The one suggestion to add a helper-model key: once, never on Cloud, and Not now sticks until another inbox arrives.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { createHelperSuggestionRoutes } from "../routes/helper-suggestion.ts";
import { Store } from "../store.ts";
import { createHelperSuggestion, HELPER_KEY_SUGGESTION_TEXT } from "./helper-suggestion.ts";
import { proactiveOwner } from "./proactive-owner.ts";

const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const guest: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(options: { cloud?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-helper-suggestion-"));
  dirs.push(dir);
  const store = new Store(() => ({ instanceId: "codex", model: "gpt-5.5" }));
  const chief = store.createBot({ name: "Chief" });
  store.setChiefOfStaff(chief.id);
  let settled = false;
  let busy = false;
  const make = () => createHelperSuggestion({
    store, dataDir: dir, cloud: options.cloud ?? false, settled: () => settled, owner: () => proactiveOwner(store),
    mainThread: (botId) => store.bot(botId)!.threadId, threadBusy: () => busy,
  });
  let suggestion = make();
  const thread = () => store.bot(chief.id)!.threadId;
  const cards = () => store.messagesFor(thread()).filter((message) => message.setupSuggestion);
  return {
    get suggestion() { return suggestion; }, restart: () => { suggestion = make(); }, store, chief, thread, cards,
    settle: (value: boolean) => { settled = value; }, busy: (value: boolean) => { busy = value; },
  };
}

describe("the add-a-key suggestion", () => {
  it("is posted once, by the proactive bot in its own chat, as a suggestion and not an approval", () => {
    const s = setup();
    expect(s.suggestion.consider({ gmailConnected: true, inbox: "Me@X.test" })).toMatchObject({ posted: expect.any(String) });
    expect(s.suggestion.consider({ gmailConnected: true, inbox: "me@x.test" })).toBeNull();
    s.restart();
    expect(s.suggestion.consider({ gmailConnected: true, inbox: "me@x.test" })).toBeNull();
    expect(s.cards()).toHaveLength(1);
    const [card] = s.cards();
    expect(card).toMatchObject({ role: "bot", kind: "text", text: HELPER_KEY_SUGGESTION_TEXT, setupSuggestion: { kind: "helperKey" } });
    expect(card!.card).toBeUndefined();
    expect(card!.widget).toBeUndefined();
    expect(s.store.taskByThread(s.chief.id, s.thread())?.unread).toBe(true);
  });

  it("is never shown on Cloud, where the keys come with the plan", () => {
    const s = setup({ cloud: true });
    expect(s.suggestion.consider({ gmailConnected: true, inbox: "me@x.test" })).toBeNull();
    expect(s.cards()).toEqual([]);
  });

  it("needs Gmail connected and no helper model, and waits for a busy chat", () => {
    const s = setup();
    expect(s.suggestion.consider({ gmailConnected: false })).toBeNull();
    s.settle(true);
    expect(s.suggestion.consider({ gmailConnected: true })).toBeNull();
    s.settle(false);
    s.busy(true);
    expect(s.suggestion.consider({ gmailConnected: true })).toBeNull();
    expect(s.cards()).toEqual([]);
    s.busy(false);
    expect(s.suggestion.consider({ gmailConnected: true })).not.toBeNull();
  });

  it("Not now sticks, through a restart, and the card says so", () => {
    const s = setup();
    const { posted } = s.suggestion.consider({ gmailConnected: true, inbox: "me@x.test" })!;
    expect(s.suggestion.notNow(s.thread(), posted, owner, ["me@x.test"])).toBe("kept");
    expect(s.cards()[0]!.setupSuggestion).toEqual({ kind: "helperKey", answer: "notNow" });
    s.restart();
    expect(s.suggestion.consider({ gmailConnected: true, inbox: "me@x.test" })).toBeNull();
    expect(s.suggestion.consider({ gmailConnected: true })).toBeNull();
    expect(s.cards()).toHaveLength(1);
  });

  it("after Not now, another inbox brings it back once more, and never again", () => {
    const s = setup();
    const first = s.suggestion.consider({ gmailConnected: true, inbox: "me@x.test" })!;
    s.suggestion.notNow(s.thread(), first.posted, owner, ["me@x.test"]);
    const second = s.suggestion.consider({ gmailConnected: true, inbox: "work@y.test" });
    expect(second).not.toBeNull();
    s.suggestion.notNow(s.thread(), second!.posted, owner, ["work@y.test"]);
    expect(s.suggestion.consider({ gmailConnected: true, inbox: "third@z.test" })).toBeNull();
    expect(s.cards()).toHaveLength(2);
  });

  it("a card left unanswered is never posted again, even for another inbox", () => {
    const s = setup();
    s.suggestion.consider({ gmailConnected: true, inbox: "me@x.test" });
    expect(s.suggestion.consider({ gmailConnected: true, inbox: "work@y.test" })).toBeNull();
    expect(s.cards()).toHaveLength(1);
  });

  it("only the owner answers, and only a card the suggestion posted", async () => {
    const s = setup();
    const { posted } = s.suggestion.consider({ gmailConnected: true, inbox: "me@x.test" })!;
    expect(s.suggestion.notNow(s.thread(), posted, guest, [])).toBe("refused");
    const other = s.store.appendMessage(s.thread(), { role: "bot", kind: "text", text: "hello" });
    expect(s.suggestion.notNow(s.thread(), other.id, owner, [])).toBe("unknown");
    const route = createHelperSuggestionRoutes({ notNow: (threadId, messageId, auth) => s.suggestion.notNow(threadId, messageId, auth, []) });
    const answer = async (auth: RequestAuth, body: unknown) => {
      let status = 0;
      await route({ req: {} as never, res: {} as never, url: new URL("http://x/"), path: "/api/helpers/suggestion/not-now", method: "POST", auth, json: (_res: unknown, code: number) => { status = code; }, readBody: async () => body } as never);
      return status;
    };
    expect(await answer(guest, { threadId: s.thread(), messageId: posted })).toBe(403);
    expect(await answer(owner, { threadId: s.thread() })).toBe(400);
    expect(await answer(owner, { threadId: s.thread(), messageId: posted })).toBe(200);
    expect(s.cards()[0]!.setupSuggestion?.answer).toBe("notNow");
  });
});
