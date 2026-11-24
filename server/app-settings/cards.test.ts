import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SETTINGS_CARD_IDS } from "../../shared/app-settings.ts";
import { APP_SETTINGS_TOOL_DEFINITION } from "../drivers/agents-app-settings-tool.ts";
import { transcriptText } from "../replies.ts";
import type { BotRecord, Message } from "../store.ts";
import { SETTINGS_CARDS } from "./cards.ts";
import { createAppSettings, WRITE_BUDGET } from "./host.ts";

const ADDRESS = "macmini.tail1234.ts.net";
const SECRETS = [ADDRESS, "http://", "https://", "/pair#code=", "ABCD-EFGH-IJKL", "omb_pair_"];
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fixture(options: { owner?: boolean; guest?: boolean; group?: boolean; here?: boolean; on?: true | null; cards?: false } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "settings-cards-"));
  dirs.push(dataDir);
  const messages: Array<Message & { threadId: string }> = [];
  const store = {
    appendMessage: (threadId: string, message: Record<string, unknown>) => {
      const row = { ...message, id: `m${messages.length + 1}`, threadId } as Message & { threadId: string };
      messages.push(row);
      return row as never;
    },
    bot: (id: string) => (id === "kiwi" ? ({ id: "kiwi", name: "Kiwi", color: "green", threadId: "t-kiwi" } as unknown as BotRecord) : undefined),
    messagesFor: () => messages as never,
    patchMessage: () => null,
  };
  const host = createAppSettings({
    store: store as never, dataDir, entries: [],
    turnOwner: () => (options.owner === false ? null : "owner"),
    guestDriven: () => options.guest === true,
    requestCredential: async () => ({ status: 500, body: {} }),
    connectorThread: () => (options.group ? { group: { id: "g", name: "Room" } as never } : null),
    language: () => "en",
    ...(options.cards === false ? {} : { cards: { here: () => options.here !== false, on: () => options.on ?? null } }),
  });
  const show = (card: unknown, generation = "g1") => host.handle({ action: "show_card", card }, { botId: "kiwi", threadId: "t-kiwi", generation });
  return { show, messages };
}

describe("app_settings show_card", () => {
  it("refuses an id outside the list and shows nothing", async () => {
    const { show, messages } = fixture();
    for (const card of ["phone-pairing", "keep-awake", "vault", "", undefined, 7, { id: "other-computers" }, "__proto__", "constructor"]) {
      const answer = await show(card);
      expect(answer.status, String(card)).toBe(404);
      expect(String(answer.body.error)).toContain("Cards: other-computers, ai-sign-in.");
    }
    expect(messages).toEqual([]);
  });

  it("posts a row that names the setting only, and tells the bot one fixed status", async () => {
    const { show, messages } = fixture({ on: true });
    const answer = await show("other-computers");
    expect(answer.status).toBe(200);
    expect(messages).toEqual([{ id: "m1", threadId: "t-kiwi", role: "bot", kind: "text", text: SETTINGS_CARDS["other-computers"].text, settingsCard: { id: "other-computers" } }]);
    expect(answer.body).toEqual({ text: expect.stringMatching(/^Card shown: Your other computers\. Your other computers is on now\. Only the user can change it; you cannot, and you never see what the card shows\./) });
    expect(String(answer.body.text)).toContain("if the card shows a switch, turn it on there; otherwise open MausBot on that computer, Settings → Devices");
    expect(String(answer.body.text)).toContain("Connect to another computer");
  });

  it("never tells the bot the setting is off: the server knows on, or cannot tell (off, or on with nothing answering)", async () => {
    const unknown = String((await fixture({ on: null }).show("other-computers")).body.text);
    expect(unknown).toContain("Whether Your other computers is on is not known to you: it may be off, or on but not reachable yet, so do not say it is off");
    expect(unknown).not.toMatch(/is (on|off) now/);
    expect(String((await fixture({ on: true }).show("other-computers")).body.text)).not.toContain("not known");
  });

  it("AI sign-in shows on any place, says nothing about on or off, and in a room names its real place", async () => {
    const { show, messages } = fixture({ here: true, on: null });
    const answer = await show("ai-sign-in");
    expect(messages).toEqual([{ id: "m1", threadId: "t-kiwi", role: "bot", kind: "text", text: SETTINGS_CARDS["ai-sign-in"].text, settingsCard: { id: "ai-sign-in" } }]);
    expect(answer.body.text).toBe("Card shown: AI sign-in. Only the user can change it; you cannot, and you never see what the card shows. " + SETTINGS_CARDS["ai-sign-in"].guide);
    expect(String((await fixture({ group: true }).show("ai-sign-in")).body.text)).toContain("open Settings → AI → Providers in MausBot");
  });

  it("in a room, where no control is drawn, posts nothing and tells the bot where the person finds it", async () => {
    const { show, messages } = fixture({ group: true, on: true });
    const answer = await show("other-computers");
    expect(answer).toEqual({ status: 200, body: { text: "No card shown: a settings control is not drawn in a room. Tell the user in one line to open Settings → Devices → Private network → Your other computers in MausBot on the computer itself, or to ask you in your own chat, where you can show it." } });
    expect(messages).toEqual([]);
  });

  it("never puts a code, a link or an address in the reply, the row or the transcript the engine reads", async () => {
    for (const on of [true, null] as const) {
      const { show, messages } = fixture({ on });
      const answer = await show("other-computers");
      const row = messages[0]!;
      const seen = [JSON.stringify(answer.body), JSON.stringify(row), transcriptText(row, new Map())];
      for (const text of seen) for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
      expect(Object.keys(row).sort()).toEqual(["id", "kind", "role", "settingsCard", "text", "threadId"]);
    }
  });

  it("replays to the engine as the app's own card, with the fixed text only", () => {
    const row = { id: "m1", role: "bot", kind: "text", text: SETTINGS_CARDS["other-computers"].text, settingsCard: { id: "other-computers" } } as Message;
    const replayed = transcriptText(row, new Map());
    expect(replayed).toMatch(/^\[Records from a settings control MausBot \(the app\) showed to the person in this chat because you asked for it; the person works it themselves, and nothing it shows is sent to you/);
    expect(replayed).toContain(SETTINGS_CARDS["other-computers"].text);
  });

  it("on a Cloud or a server with no desktop app, shows no card and says where it is set", async () => {
    for (const options of [{ here: false }, { cards: false as const }]) {
      const { show, messages } = fixture(options);
      const answer = await show("other-computers");
      expect(answer).toEqual({ status: 200, body: { text: "No card shown: Your other computers is set in the MausBot desktop app on the computer itself, in Settings → Devices → Private network. Tell the user that in one line." } });
      expect(messages).toEqual([]);
    }
  });

  it("shows only in a turn the server counts as the owner's own (turnOwner), and never where a guest drives the thread", async () => {
    for (const options of [{ owner: false }, { guest: true }]) {
      const { show, messages } = fixture(options);
      expect((await show("other-computers")).status).toBe(403);
      expect(messages).toEqual([]);
    }
  });

  it("counts against the turn's change budget, so one turn can't fill the chat with cards", async () => {
    const { show, messages } = fixture();
    for (let index = 0; index < WRITE_BUDGET; index++) expect((await show("other-computers")).status).toBe(200);
    expect((await show("other-computers")).status).toBe(429);
    expect(messages).toHaveLength(WRITE_BUDGET);
  });

  it("the tool's schema offers exactly the registered cards, and the bot has no action that changes one", () => {
    const { properties } = APP_SETTINGS_TOOL_DEFINITION.inputSchema;
    expect(properties.card.enum).toEqual([...SETTINGS_CARD_IDS]);
    expect(Object.keys(SETTINGS_CARDS)).toEqual([...SETTINGS_CARD_IDS]);
    expect(properties.card.description).toBe("show_card: other-computers when the person asks how to connect or open this computer from another computer; "
      + "ai-sign-in when the person wants to sign in to an AI account (Claude, ChatGPT or Codex, Antigravity), or one is signed out.");
    expect(properties.action.enum).toContain("show_card");
    expect(APP_SETTINGS_TOOL_DEFINITION.description).toContain("you cannot change it or see what it shows");
  });
});
