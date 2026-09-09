// Per-bot profile history: one NDJSON row per changed field, full text only
// for the soul, secrets scrubbed, and a revision token that moves when any
// of the four profile fields move.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { botFolder } from "./bot-folder.ts";
import { profileRevision, profileSnapshot } from "./profile-revision.ts";
import {
  flushAllProfileHistory,
  flushProfileHistory,
  historyFile,
  readHistory,
  recordProfileChange,
} from "./profile-versions.ts";

const base = { name: "Scout", title: "", description: "", soul: "" };

/** A real bot's folder exists before any profile change can fire (it is
 * created at bot creation, via writeSoulMirror). Mirror that invariant here
 * so these tests exercise the same path recordProfileChange does in
 * production, instead of relying on writeRows to create the folder itself. */
function withBotFolder(id: string): void {
  mkdirSync(botFolder(id), { recursive: true, mode: 0o700 });
}

describe("profileRevision", () => {
  it("is stable for equal profiles and moves when any field moves", () => {
    expect(profileRevision(base)).toBe(profileRevision({ ...base }));
    expect(profileRevision(base)).toMatch(/^[0-9a-f]{64}$/);
    for (const field of ["name", "title", "description", "soul", "cwd"] as const) {
      expect(profileRevision({ ...base, [field]: "x" })).not.toBe(profileRevision(base));
    }
    expect(profileSnapshot({ name: "A", title: "B", description: "C", soul: undefined })).toEqual({
      name: "A", title: "B", description: "C", soul: "", cwd: "",
    });
  });
});

describe("profile history", () => {
  it("reads a bounded tail and keeps legacy ids stable as the window moves", () => {
    const id = "hist-bounded";
    withBotFolder(id);
    const old = { at: 1, actor: "user", field: "soul", before: "old", after: "new" };
    writeFileSync(historyFile(id), JSON.stringify(old) + "\n" + "x".repeat(9 * 1024 * 1024) + "\n" + JSON.stringify({ ...old, at: 2 }) + "\n");
    const first = readHistory(id);
    expect(first.map((row) => row.at)).toEqual([2]);
    appendFileSync(historyFile(id), JSON.stringify({ ...old, at: 3 }) + "\n");
    expect(readHistory(id).find((row) => row.at === 2)?.id).toBe(first[0].id);
    expect(readHistory(id, 1).map((row) => row.at)).toEqual([3]);
  });
  it("identifies same-millisecond changes and legacy rows independently", async () => {
    const id = "hist-collision";
    withBotFolder(id);
    const clock = vi.spyOn(Date, "now").mockReturnValue(123);
    try {
      recordProfileChange(id, "user", "ui", base, { ...base, soul: "first" });
      recordProfileChange(id, "user", "ui", { ...base, soul: "first" }, { ...base, soul: "second" });
      await flushProfileHistory(id);
    } finally { clock.mockRestore(); }
    appendFileSync(historyFile(id), JSON.stringify({ at: 123, actor: "user", field: "soul", before: "legacy", after: "old", summary: "old" }) + "\n");
    const rows = readHistory(id);
    expect(rows.map((row) => row.at)).toEqual([123, 123, 123]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(readHistory(id).map((row) => row.id)).toEqual(rows.map((row) => row.id));
  });
  it("writes one redacted row per changed field with private mode, newest first on read", async () => {
    const id = "hist-1";
    withBotFolder(id);
    recordProfileChange(id, "user", "ui", base, { ...base, name: "Kiwi", title: "Tracker" });
    recordProfileChange(id, "bot", "card:abc", { ...base, name: "Kiwi", title: "Tracker" }, {
      ...base, name: "Kiwi", title: "Tracker", soul: "token sk-ant-api03-SECRETSECRETSECRETSECRET\nBe brief.",
    });
    await flushProfileHistory(id);
    if (process.platform !== "win32") expect(statSync(historyFile(id)).mode & 0o777).toBe(0o600);
    const rows = readHistory(id);
    expect(rows.map((r) => r.field)).toEqual(["soul", "title", "name"]);
    expect(rows[2]).toMatchObject({ actor: "user", via: "ui", field: "name", before: "Scout", after: "Kiwi" });
    expect(rows[2]!.summary).toBe('name: "Scout" → "Kiwi"');
    expect(rows[0]).toMatchObject({ actor: "bot", via: "card:abc", field: "soul", before: "" });
    expect(rows[0]!.after).toContain("Be brief.");
    expect(rows[0]!.after).not.toContain("SECRETSECRET");
    expect(rows[0]!.summary).toMatch(/^soul: 0 → \d+ bytes$/);
  });

  it("writes nothing when nothing changed, and trims long non-soul values", async () => {
    const id = "hist-2";
    withBotFolder(id);
    recordProfileChange(id, "user", "api", base, { ...base });
    await flushProfileHistory(id);
    expect(existsSync(historyFile(id))).toBe(false);
    recordProfileChange(id, "user", "api", base, { ...base, description: "d".repeat(500) });
    await flushProfileHistory(id);
    const [row] = readHistory(id);
    expect(row!.after!.length).toBe(200);
    expect(readFileSync(historyFile(id), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("does not offer redacted before-text for restore, but keeps exact non-secret versions restorable", async () => {
    const id = "hist-restore-redaction";
    withBotFolder(id);
    const exact = "  Be brief.\n\nKeep the user's whitespace.  \n";
    const secret = "Use sk-ant-api03-SECRETSECRETSECRETSECRET privately.";
    recordProfileChange(id, "user", "ui", { ...base, soul: exact }, { ...base, soul: secret });
    recordProfileChange(id, "user", "ui", { ...base, soul: secret }, { ...base, soul: "Current instructions." });
    await flushProfileHistory(id);
    const [unsafe, safe] = readHistory(id);
    expect(unsafe).toMatchObject({ canRestore: false });
    expect(unsafe.restoreUnavailableReason).toMatch(/redacted.*cannot be restored/);
    expect(unsafe.before).toContain("«redacted ");
    expect(safe).toMatchObject({ before: exact, canRestore: true });
    expect(safe.restoreUnavailableReason).toBeUndefined();
    const stored = readFileSync(historyFile(id), "utf8");
    expect(stored).not.toContain("SECRETSECRET");
    expect(JSON.parse(stored.trim().split("\n")[1]).canRestore).toBe(false);
  });

  it("rejects legacy redaction markers even if the row claims it can be restored", () => {
    const id = "hist-legacy-redaction";
    withBotFolder(id);
    const row = { at: 1, actor: "user", field: "soul", before: "Keep «redacted 40 chars» private.", after: "Current." };
    writeFileSync(historyFile(id), [row, { ...row, at: 2, canRestore: true }].map((value) => JSON.stringify(value)).join("\n") + "\n");
    expect(readHistory(id).map((value) => value.canRestore)).toEqual([false, false]);
  });

  it("caps reads and survives a torn line", async () => {
    const id = "hist-3";
    withBotFolder(id);
    for (let i = 0; i < 5; i++) recordProfileChange(id, "user", "ui", { ...base, name: `n${i}` }, { ...base, name: `n${i + 1}` });
    await flushProfileHistory(id);
    expect(readHistory(id, 2).map((r) => r.after)).toEqual(["n5", "n4"]);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(historyFile(id), '{"at":1,"acto');
    expect(readHistory(id)).toHaveLength(5);
  });

  it("skips the write (and never recreates the folder) for a bot that no longer exists", async () => {
    const id = "hist-removed";
    rmSync(botFolder(id), { recursive: true, force: true });
    recordProfileChange(id, "user", "ui", base, { ...base, name: "Kiwi" });
    await flushProfileHistory(id);
    expect(existsSync(botFolder(id))).toBe(false);
    expect(existsSync(historyFile(id))).toBe(false);
    expect(readHistory(id)).toEqual([]);
  });

  it("flushAllProfileHistory waits out every bot's queue at once", async () => {
    const a = "hist-flush-a";
    const b = "hist-flush-b";
    withBotFolder(a);
    withBotFolder(b);
    recordProfileChange(a, "user", "ui", base, { ...base, name: "A" });
    recordProfileChange(b, "user", "ui", base, { ...base, name: "B" });
    await flushAllProfileHistory();
    expect(readHistory(a)).toHaveLength(1);
    expect(readHistory(b)).toHaveLength(1);
  });
});
