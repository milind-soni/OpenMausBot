// What every transcript row needs from the rest of the thread is worked out
// once per message list, and the time and date labels come from cached
// formatters. Each must say exactly what the per-row code it replaced said.
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

// A thread whose first question was edited twice (three forks of it, out of
// time order in the list), with replies quoting messages on other branches.
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

  it("keeps Retry on the last conversational row when a live call's record follows it", () => {
    // hanging up appends the call's record after whatever the chat ended on:
    // a failed turn must still be the row Retry belongs to
    const record = msg("call", {
      kind: "call",
      text: "Call with Ada · 1:42",
      at: 37,
      parentId: "k",
      call: { callId: "c1", botId: "ada", client: "ios", startedAt: 0, endedAt: 37, seconds: 102, endReason: "hung-up" },
    });
    expect(transcriptLookups([...all, record], [...branch, record]).retryableId).toBe("o");
    // also when the record sits among the turn's receipts, in either order
    expect(transcriptLookups([root, record, digest], [root, record, digest]).retryableId).toBe("root");
    expect(transcriptLookups([root, digest, record], [root, digest, record]).retryableId).toBe("root");
    // a chat that is only a call has nothing to retry
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

// Day numbers have to agree with toDateString across midnight and across
// the clock changes, where a day is 23 or 25 hours long — in a zone a few
// hours from UTC and in one half a day away, where rounding goes wrong.
describe.each([
  // spring forward, fall back
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
      // the zone took effect: the clock changed between these two
      expect(before.getTimezoneOffset()).not.toBe(after.getTimezoneOffset());
      expect(localDay(after.getTime()) - localDay(before.getTime())).toBe(2);
      expect(localDay(new Date(year!, month!, day!, 0, 30).getTime()) - localDay(new Date(year!, month!, day! - 1, 23, 30).getTime())).toBe(1);
    }
  });
});
