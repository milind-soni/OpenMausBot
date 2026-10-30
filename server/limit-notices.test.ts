import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LimitNotices, UNNAMED_STRETCH_MS, limitNoticeText } from "./limit-notices.ts";
import { UNNAMED_LIMIT_MS } from "./limit-resets.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function notices(now: { at: number }) {
  const dir = mkdtempSync(join(tmpdir(), "omb-limit-notices-"));
  dirs.push(dir);
  return { file: join(dir, "limit-notices.json"), make: () => new LimitNotices(join(dir, "limit-notices.json"), () => now.at) };
}

describe("one notice per bot for each stretch of a limit", () => {
  it("says it once while the limit lasts, again after it reset, and remembers it across a restart", () => {
    const now = { at: 1_000_000 };
    const { make } = notices(now);
    const ledger = make();
    const resetsAt = now.at + 60 * 60_000;
    expect(ledger.first("kai", "codex", resetsAt)).toBe(true);
    for (let turn = 0; turn < 5; turn += 1) expect(ledger.first("kai", "codex", resetsAt)).toBe(false);
    expect(ledger.first("rosa", "codex", resetsAt), "another bot hears it once too").toBe(true);
    expect(make().first("kai", "codex", resetsAt), "after a restart").toBe(false);
    now.at = resetsAt + 1;
    expect(ledger.first("kai", "codex", now.at + 60_000), "a new stretch").toBe(true);
  });

  it("keeps a limit that named no reset one stretch through the retry after its hour, and ends it when the engine works", () => {
    const now = { at: 5_000_000 };
    const ledger = notices(now).make();
    expect(ledger.first("kai", "codex")).toBe(true);
    now.at += UNNAMED_LIMIT_MS + 60_000;
    expect(ledger.first("kai", "codex"), "the hourly retry, refused again").toBe(false);
    now.at += UNNAMED_LIMIT_MS + 60_000;
    expect(ledger.first("kai", "codex"), "still refusing: the same stretch").toBe(false);
    ledger.ended("kai", "codex");
    expect(ledger.first("kai", "codex")).toBe(true);
    now.at += UNNAMED_STRETCH_MS + 1;
    expect(ledger.first("kai", "codex"), "no refusal for the whole stretch: a new one").toBe(true);
  });
});

describe("the notice", () => {
  it("says in one line what carries on meanwhile, or that the bot waits", () => {
    const resetsAt = new Date(2026, 9, 27, 14, 0).getTime();
    expect(limitNoticeText({ engine: "Codex", bot: "Kai", resetsAt, backup: "Claude" }, "UTC").replace(/\d{1,2}:\d{2}\s?[AP]M/, "14:00"))
      .toMatch(/^Codex reached its limit until (?:[A-Z][a-z]{2} )?14:00, so Kai is using Claude meanwhile\.$/);
    expect(limitNoticeText({ engine: "Codex", bot: "Kai", backup: "Claude" })).toBe("Codex reached its limit, so Kai is using Claude meanwhile.");
    expect(limitNoticeText({ engine: "Claude claude-opus-5-5", bot: "Iris", credits: true, backup: "Claude claude-sonnet-5" }))
      .toBe("Claude claude-opus-5-5's extra usage credits are used up, so Iris is using Claude claude-sonnet-5 meanwhile.");
    expect(limitNoticeText({ engine: "Codex", bot: "Kai" })).toBe("Codex reached its limit, so Kai waits: no other AI you have set up can take over.");
    expect(limitNoticeText({ engine: "Claude claude-opus-5-5", bot: "Iris", credits: true, resetsAt: Date.now() + 86_400_000 }))
      .toBe("Claude claude-opus-5-5's extra usage credits are used up, so Iris waits: no other AI you have set up can take over.");
  });
});
