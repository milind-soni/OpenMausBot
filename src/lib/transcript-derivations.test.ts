import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { formatTime } from "@/state/store";
import { setLocale, t } from "./i18n";
import { dayLabel, localDay, transcriptLookups } from "./transcript-derivations";

// The per-row code these replace, kept here as the reference.
function versionsBefore(all: Message[], message: Message): Message[] {
  if (message.role !== "user" || message.kind !== "text") return [message];
  return all
    .filter((m) => m.role === "user" && m.kind === "text" && (m.parentId ?? null) === (message.parentId ?? null))
    .sort((a, b) => a.at - b.at);
}
const replyTargetBefore = (all: Message[], message: Message) =>
  message.replyToId ? all.find((candidate) => candidate.id === message.replyToId) : undefined;
const retryableBefore = (branch: Message[]) =>
  [...branch].reverse().find((message) => message.kind !== "digest" && message.kind !== "compaction")?.id;
function dayLabelBefore(at: number, locale: string): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return t("chat.day.today");
  if (diffDays === 1) return t("chat.day.yesterday");
  return d.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" });
}

const msg = (id: string, fields: Partial<Message>): Message => ({ id, role: "bot", kind: "text", at: 0, ...fields });

// The first question edited twice (three forks, out of time order), with replies quoting other branches.
const root = msg("root", { text: "Ready", at: 1 });
const q1 = msg("q1", { role: "user", text: "first", at: 10, parentId: "root" });
const a1 = msg("a1", { text: "old answer", at: 11, parentId: "q1" });
const q3 = msg("q3", { role: "user", text: "third", at: 30, parentId: "root" });
const q2 = msg("q2", { role: "user", text: "second", at: 20, parentId: "root" });
const a3 = msg("a3", { text: "answer", at: 31, parentId: "q3" });
const follow = msg("f", { role: "user", text: "and this?", at: 32, parentId: "a3", replyToId: "a1" });
const chip = msg("c", { kind: "activity", tool: { name: "Read", ok: true }, at: 33, parentId: "f" });
const pick = msg("o", { role: "user", kind: "options", at: 34, parentId: "c", replyToId: "gone" });
const digest = msg("d", { kind: "digest", text: "did things", at: 35, parentId: "o" });
const compaction = msg("k", { kind: "compaction", at: 36, parentId: "d" });
const all = [root, q1, a1, q3, q2, a3, follow, chip, pick, digest, compaction];
const branch = [root, q3, a3, follow, chip, pick, digest, compaction];

describe("transcriptLookups", () => {
  const lookups = transcriptLookups(all, branch);

  it("gives every message the edit versions the per-bubble scan gave", () => {
    for (const message of all) {
      expect(lookups.editVersions(message) ?? [message]).toEqual(versionsBefore(all, message));
    }
    expect(lookups.editVersions(q3)!.map((m) => m.id)).toEqual(["q1", "q2", "q3"]);
  });

  it("leaves a question that was never edited without versions", () => {
    expect(lookups.editVersions(follow)).toBeUndefined();
    expect(lookups.editVersions(a3)).toBeUndefined();
  });

  it("finds reply targets on any branch, as the per-bubble find did", () => {
    for (const message of all) expect(lookups.replyTarget(message)).toBe(replyTargetBefore(all, message));
    expect(lookups.replyTarget(follow)).toBe(a1);
  });

  it("puts Retry on the last conversational row, past digests and compactions", () => {
    expect(lookups.retryableId).toBe(retryableBefore(branch));
    expect(lookups.retryableId).toBe("o");
    expect(transcriptLookups([], []).retryableId).toBeUndefined();
    expect(transcriptLookups([digest], [digest]).retryableId).toBeUndefined();
  });

  it("keeps Retry on a turn its AI's sign-out stopped, past the notice about that sign-in", () => {
    const failed = msg("e", { kind: "activity", tool: { name: "error: Not logged in · Please run /login", ok: false, setup: true }, at: 40, parentId: "f" });
    const signedOut = msg("n", { kind: "activity", tool: { name: "notice: Claude is signed out on this computer.", ok: true, setup: true }, at: 41, parentId: "e" });
    const signedIn = msg("n", { kind: "activity", tool: { name: "notice: Claude is signed in again.", nameCode: "chat.notice.signedInAgain", nameParams: { engine: "Claude" }, ok: true }, at: 41, parentId: "e" });
    const turnDigest = msg("d2", { kind: "digest", text: "turn failed", at: 42, parentId: "n" });
    for (const notice of [signedOut, signedIn]) {
      const path = [root, q3, a3, follow, failed, notice, turnDigest];
      expect(transcriptLookups(path, path).retryableId).toBe("e");
    }
    const partlyRan = msg("p", { kind: "activity", tool: { name: "notice: switched to Codex. Part of your request had already run, so it was not sent again.", nameCode: "chat.notice.backupAlreadyRan", nameParams: { name: "Codex" }, ok: false }, at: 41, parentId: "e" });
    expect(transcriptLookups([root, follow, failed, partlyRan], [root, follow, failed, partlyRan]).retryableId).toBe("p");
  });

  it("keeps Retry on the last conversational row when a live call's record follows it", () => {
    const record = msg("call", {
      kind: "call",
      text: "Call with Ada · 1:42",
      at: 37,
      parentId: "k",
      call: { callId: "c1", botId: "ada", client: "ios", startedAt: 0, endedAt: 37, seconds: 102, endReason: "hung-up" },
    });
    expect(transcriptLookups([...all, record], [...branch, record]).retryableId).toBe("o");
    expect(transcriptLookups([root, record, digest], [root, record, digest]).retryableId).toBe("root");
    expect(transcriptLookups([root, digest, record], [root, digest, record]).retryableId).toBe("root");
    expect(transcriptLookups([record], [record]).retryableId).toBeUndefined();
  });
});

describe("formatTime", () => {
  it("says what toLocaleTimeString said, in the browser's own locale", () => {
    const options = { hour: "numeric", minute: "2-digit" } as const;
    for (const at of [0, 1_700_000_000_000, Date.UTC(2026, 2, 8, 6, 59), Date.UTC(2026, 9, 3, 23, 30), Date.now()]) {
      expect(formatTime(at)).toBe(new Date(at).toLocaleTimeString([], options));
    }
  });
});

describe("dayLabel", () => {
  afterEach(() => setLocale("en"));

  it("matches the per-row label for today, yesterday and older days", () => {
    const now = Date.now();
    for (const days of [0, 1, 2, 6, 40, 400]) {
      const at = now - days * 86_400_000;
      expect(dayLabel(at)).toBe(dayLabelBefore(at, "en"));
    }
  });

  it("follows the app language when it changes", () => {
    const at = Date.UTC(2025, 0, 6, 12);
    expect(dayLabel(at)).toBe(dayLabelBefore(at, "en"));
    setLocale("de");
    expect(dayLabel(at)).toBe(dayLabelBefore(at, "de"));
    expect(dayLabel(at)).not.toBe(new Date(at).toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" }));
    setLocale("fr");
    expect(dayLabel(at)).toBe(dayLabelBefore(at, "fr"));
  });
});

// Zones a few hours and half a day from UTC, across 23- and 25-hour days, where rounding goes wrong.
describe.each([
  { zone: "America/New_York", changes: [[2026, 2, 8], [2026, 10, 1]] },
  { zone: "Pacific/Auckland", changes: [[2026, 3, 5], [2026, 8, 27]] },
])("localDay in $zone", ({ zone, changes }) => {
  const previousZone = process.env.TZ;
  beforeAll(() => { process.env.TZ = zone; });
  afterAll(() => { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; });

  const sameDayBefore = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

  it("agrees with toDateString on every pair of nearby instants", () => {
    for (const [year, month, day] of [...changes, [2026, 11, 31]]) {
      const start = new Date(year!, month!, day! - 1, 12).getTime();
      const instants = Array.from({ length: 4 * 48 }, (_, i) => start + i * 15 * 60_000);
      for (const a of instants) {
        for (const b of [a + 60_000, a + 3_600_000, a + 23 * 3_600_000, a + 25 * 3_600_000]) {
          expect(localDay(a) === localDay(b)).toBe(sameDayBefore(a, b));
        }
      }
    }
  });

  it("counts whole days across a clock change", () => {
    for (const [year, month, day] of changes) {
      const before = new Date(year!, month!, day! - 1, 12);
      const after = new Date(year!, month!, day! + 1, 12);
      expect(before.getTimezoneOffset()).not.toBe(after.getTimezoneOffset());
      expect(localDay(after.getTime()) - localDay(before.getTime())).toBe(2);
      expect(localDay(new Date(year!, month!, day!, 0, 30).getTime()) - localDay(new Date(year!, month!, day! - 1, 23, 30).getTime())).toBe(1);
    }
  });
});

describe("newChatHintId", () => {
  const summary = msg("sum", { kind: "compaction", compaction: { summary: "s", firstKeptId: "", foldedThroughId: "a", tokensBefore: 1, by: "harness" } });
  const engine = msg("eng", { kind: "compaction", engineCompaction: true });
  const fresh = msg("fresh", { kind: "compaction", compaction: { summary: "", firstKeptId: "", foldedThroughId: "a", tokensBefore: 0, by: "person", fresh: true } });
  const reply = msg("r", { text: "hi" });
  it("marks only the newest compaction, and none once the chat started fresh", () => {
    expect(transcriptLookups([reply], [reply]).newChatHintId).toBeUndefined();
    expect(transcriptLookups([summary, reply, engine, reply], [summary, reply, engine, reply]).newChatHintId).toBe("eng");
    expect(transcriptLookups([engine, summary, reply], [engine, summary, reply]).newChatHintId).toBe("sum");
    expect(transcriptLookups([summary, fresh, reply], [summary, fresh, reply]).newChatHintId).toBeUndefined();
  });
});
