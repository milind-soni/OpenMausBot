import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { failedTurnTool } from "../../shared/failed-turn.ts";
import { settingFix, SPEND_LIMIT_REFUSAL } from "../../shared/setting-fixes.ts";
import { failedNoticeTool } from "../chat-notices.ts";
import { engineFailure } from "../drivers/engine-errors.ts";
import type { Message } from "../store.ts";
import { createSettingNudges, type NudgeTurn } from "./setting-nudges.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const credits = () => failedTurnTool(engineFailure("OpenRouter", "HTTP 402: Payment Required")!.message);
const signedOut = () => failedTurnTool("Claude is signed out. Sign in again in Settings → AI to keep using it.", { setup: true });
const spend = () => failedTurnTool(`${SPEND_LIMIT_REFUSAL} of $5.00 — an admin can raise it under Settings → Spending`);
const OWNER: NudgeTurn = { tools: true, owner: true, model: "openrouter/free" };

function fixture(dataDir = mkdtempSync(join(tmpdir(), "nudges-"))) {
  dirs.push(dataDir);
  const rows: Message[] = [];
  const add = (row: Partial<Message>) => rows.push({ id: `m${rows.length + 1}`, at: rows.length, role: "bot", kind: "text", text: "", ...row } as Message);
  const failed = (tool: NonNullable<Message["tool"]>) => add({ kind: "activity", tool });
  const asks = () => add({ role: "user", text: "and now?" });
  const replies = () => add({ text: "Here it is." });
  const nudges = createSettingNudges({ dataDir, store: { messagesFor: () => rows } });
  /** One turn: the note it carries, as index.ts asks for it when the turn starts. */
  const turn = (over: Partial<NudgeTurn> = {}) => nudges.note("t", { ...OWNER, ...over });
  return { dataDir, rows, add, failed, asks, replies, turn };
}

describe("the setting that fixes a failed turn", () => {
  it("reads the row the server stored: another model, the AI's sign-in, or our own spend-cap refusal", () => {
    expect(settingFix(credits())).toBe("model");
    expect(settingFix(failedTurnTool(engineFailure("Groq", "HTTP 429: slow down")!.message))).toBe("model");
    expect(settingFix(failedNoticeTool("chat.notice.modelNoRouteUnnamed", { provider: "OpenCode" }))).toBe("model");
    expect(settingFix(signedOut())).toBe("sign-in");
    expect(settingFix(spend())).toBe("spend-limit");
    expect(settingFix(failedTurnTool("OpenAI stopped with an error (HTTP 400; OpenAI says: 'You have exceeded your monthly spend limit for this project')."))).toBeNull();
    expect(settingFix(failedTurnTool("the process running this turn's AI ended"))).toBeNull();
    expect(settingFix({ name: "Read a file", ok: false } as never)).toBeNull();
  });
});

describe("setting nudges", () => {
  it("speak up when the AI failed twice since the bot last answered, once per conversation, on a person's turn with tools", () => {
    const { asks, failed, replies, turn } = fixture();
    asks(); turn(); failed(credits());
    asks(); expect(turn()).toBe(""); failed(credits());
    asks();
    expect(turn({ tools: false })).toBe("");
    const note = turn();
    expect(note).toMatch(/^\n\nOpenMausBot note: your last 2 turns in this conversation failed because your AI could not answer/);
    expect(note).toContain("app_settings set bots.model");
    expect(note).toContain("Say it this once only");
    replies();
    asks(); turn(); failed(credits());
    asks(); turn(); failed(credits());
    asks();
    expect(turn()).toBe("");
  });

  it("stay quiet about failures the bot recovered from: a reply since the last failure ends them", () => {
    const { asks, failed, replies, turn } = fixture();
    asks(); turn(); failed(credits());
    asks(); turn(); failed(credits());
    asks(); turn(); replies();
    asks();
    expect(turn()).toBe("");
    asks(); turn(); failed(credits());
    asks();
    expect(turn()).toBe("");
  });

  it("stay quiet once the person switched the model, from the row or in chat: earlier failures were on the old one", () => {
    const { asks, failed, turn } = fixture();
    asks(); turn(); failed(credits());
    asks(); turn(); failed(credits());
    asks();
    expect(turn({ model: "claude/sonnet" })).toBe("");
    failed(credits());
    asks();
    expect(turn({ model: "claude/sonnet" })).toBe("");
  });

  it("tell the bot to send a non-owner to the owner, since set bots.model is refused in their turn", () => {
    const { asks, failed, turn } = fixture();
    asks(); turn(); failed(credits());
    asks(); turn(); failed(credits());
    asks();
    const note = turn({ owner: false });
    expect(note).toContain("the owner of this place can switch you to another model; you cannot change it from this conversation");
    expect(note).not.toContain("app_settings");
  });

  it("offer it again when the turn that carried the note failed before the bot replied, and remember across a restart", () => {
    const { dataDir, rows, asks, failed, replies, turn } = fixture();
    asks(); turn(); failed(credits());
    asks(); turn(); failed(credits());
    asks(); expect(turn()).not.toBe(""); failed(credits());
    asks(); expect(turn()).toContain("your last 3 turns"); replies();
    failed(credits());
    asks(); failed(credits());
    asks();
    const restarted = createSettingNudges({ dataDir, store: { messagesFor: () => rows } });
    expect(restarted.note("t", OWNER)).toBe("");
  });

  it("never nudge about a sign-out or a spend limit: those refuse the turn itself, and the row offers the fix", () => {
    const { asks, failed, turn } = fixture();
    for (const tool of [signedOut(), signedOut(), spend(), spend()]) { asks(); turn(); failed(tool); }
    asks();
    expect(turn()).toBe("");
  });
});
