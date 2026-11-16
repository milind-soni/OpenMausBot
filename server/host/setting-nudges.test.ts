import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { failedTurnTool } from "../../shared/failed-turn.ts";
import { settingFix } from "../../shared/setting-fixes.ts";
import { failedNoticeTool } from "../chat-notices.ts";
import { engineFailure } from "../drivers/engine-errors.ts";
import type { Message } from "../store.ts";
import { createSettingNudges } from "./setting-nudges.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const credits = () => failedTurnTool(engineFailure("OpenRouter", "HTTP 402: Payment Required")!.message);
const signedOut = () => failedTurnTool("Claude is signed out. Sign in again in Settings → AI to keep using it.", { setup: true });
const spend = () => failedTurnTool("this workspace has reached its monthly spend limit of $5.00 — an admin can raise it under Settings → Spending");

function fixture(dataDir = mkdtempSync(join(tmpdir(), "nudges-"))) {
  dirs.push(dataDir);
  const rows: Message[] = [];
  const add = (row: Partial<Message>) => rows.push({ id: `m${rows.length + 1}`, at: rows.length, role: "bot", kind: "text", text: "", ...row } as Message);
  const failed = (tool: NonNullable<Message["tool"]>) => add({ kind: "activity", tool });
  const nudges = createSettingNudges({ dataDir, store: { messagesFor: () => rows } });
  return { dataDir, add, failed, nudges };
}

describe("the setting that fixes a failed turn", () => {
  it("reads the row the server stored: another model, the AI's sign-in, or the spend limit", () => {
    expect(settingFix(credits())).toBe("model");
    expect(settingFix(failedTurnTool(engineFailure("Groq", "HTTP 429: slow down")!.message))).toBe("model");
    expect(settingFix(failedNoticeTool("chat.notice.modelNoRouteUnnamed", { provider: "OpenCode" }))).toBe("model");
    expect(settingFix(signedOut())).toBe("sign-in");
    expect(settingFix(spend())).toBe("spend-limit");
    expect(settingFix(failedTurnTool("the process running this turn's AI ended"))).toBeNull();
    expect(settingFix({ name: "Read a file", ok: false } as never)).toBeNull();
  });
});

describe("setting nudges", () => {
  it("speak up after a cause repeats, once per conversation, and only on a turn with OpenMausBot's tools", () => {
    const { add, failed, nudges } = fixture();
    add({ role: "user", text: "hi" });
    failed(credits());
    expect(nudges.note("t", true)).toBe("");
    failed(credits());
    expect(nudges.note("t", false)).toBe("");
    const note = nudges.note("t", true);
    expect(note).toMatch(/^\n\nOpenMausBot note: 2 earlier turns in this conversation failed because your AI could not answer/);
    expect(note).toContain("app_settings set bots.model");
    expect(note).toContain("Say it this once only");
    add({ text: "Your OpenRouter account is out of credits. Want me to switch to another model?" });
    failed(credits());
    expect(nudges.note("t", true)).toBe("");
  });

  it("say it again when the turn that carried the note failed before the bot replied, and remember across a restart", () => {
    const { dataDir, add, failed, nudges } = fixture();
    failed(signedOut());
    failed(signedOut());
    expect(nudges.note("t", true)).toContain("app_settings show_card ai-sign-in");
    failed(signedOut());
    expect(nudges.note("t", true)).toContain("show_card ai-sign-in");
    add({ text: "Claude is signed out here; I can show you the sign-in." });
    const restarted = createSettingNudges({ dataDir, store: { messagesFor: () => [] } });
    expect(restarted.note("t", true)).toBe("");
    expect(nudges.note("t", true)).toBe("");
  });

  it("name the real place for a spend limit after one refusal", () => {
    const { failed, nudges } = fixture();
    failed(spend());
    expect(nudges.note("t", true)).toContain("only an admin raises it, in Settings → Spending (shown in Advanced mode only");
  });
});
