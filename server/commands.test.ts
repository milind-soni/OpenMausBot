// Command + receipt seam (Phase 0, item 0.5): every new mutation runs as a
// typed command whose receipt is written in the same SQLite transaction as
// its effects, so a retry with the same (kind, key) returns the stored
// result instead of applying twice.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { runCommand, commandReceipt } from "./commands.ts";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb, insertMessage, readThread } from "./message-db.ts";
import type { Message } from "./store.ts";

const msg = (id: string, text: string): Message => ({ id, role: "bot", kind: "text", text, at: 1 });

describe("runCommand", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("applies a new command once and returns its result", () => {
    let applied = 0;
    const result = runCommand({ kind: "digest.append", key: "t1:turn-1" }, () => {
      applied += 1;
      return { digestId: "d1" };
    });
    expect(result).toEqual({ digestId: "d1" });
    expect(applied).toBe(1);
  });

  it("returns the stored result on a repeat of the same kind and key without applying again", () => {
    let applied = 0;
    const apply = () => {
      applied += 1;
      return { digestId: `d${applied}` };
    };
    const first = runCommand({ kind: "digest.append", key: "t1:turn-1" }, apply);
    const second = runCommand({ kind: "digest.append", key: "t1:turn-1" }, apply);
    expect(second).toEqual(first);
    expect(applied).toBe(1);
  });

  it("keeps commands of different kinds apart even when the key matches", () => {
    runCommand({ kind: "digest.append", key: "shared" }, () => "a");
    const other = runCommand({ kind: "hook.ingest", key: "shared" }, () => "b");
    expect(other).toBe("b");
  });

  it("writes the receipt and the command's rows in one transaction", () => {
    expect(() =>
      runCommand({ kind: "digest.append", key: "t1:turn-2" }, () => {
        insertMessage("t1", msg("m1", "half done"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(readThread("t1", "/nonexistent").messages).toEqual([]);
    expect(commandReceipt("digest.append", "t1:turn-2")).toBeNull();
    // the same key can be retried after a failure
    const retried = runCommand({ kind: "digest.append", key: "t1:turn-2" }, () => {
      insertMessage("t1", msg("m1", "done"));
      return "ok";
    });
    expect(retried).toBe("ok");
    expect(readThread("t1", "/nonexistent").messages.map((m) => m.text)).toEqual(["done"]);
  });

  it("survives a restart", () => {
    runCommand({ kind: "launch.acquire", key: "ticket-9" }, () => ({ slot: 3 }));
    closeMessageDb();
    let applied = 0;
    const again = runCommand({ kind: "launch.acquire", key: "ticket-9" }, () => {
      applied += 1;
      return { slot: 99 };
    });
    expect(again).toEqual({ slot: 3 });
    expect(applied).toBe(0);
    expect(commandReceipt("launch.acquire", "ticket-9")).toMatchObject({ kind: "launch.acquire", key: "ticket-9", result: { slot: 3 } });
  });
});

describe("runCommand nesting", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("lets apply use the store's own transactional writes and keeps them atomic with the receipt", async () => {
    const { appendMessage } = await import("./message-db.ts");
    // appendMessage opens its own transaction; inside a command it must join
    // the command's transaction instead of failing with "nested transaction".
    runCommand({ kind: "digest.append", key: "t9:turn-1" }, () => {
      appendMessage("t9", msg("d1", "[digest] one"));
      return "ok";
    });
    expect(readThread("t9", "/nonexistent").messages.map((m) => m.text)).toEqual(["[digest] one"]);
    expect(commandReceipt("digest.append", "t9:turn-1")).not.toBeNull();
    // and a failure after the nested write rolls back the write too
    expect(() =>
      runCommand({ kind: "digest.append", key: "t9:turn-2" }, () => {
        appendMessage("t9", msg("d2", "[digest] two"));
        throw new Error("late failure");
      }),
    ).toThrow("late failure");
    expect(readThread("t9", "/nonexistent").messages.map((m) => m.text)).toEqual(["[digest] one"]);
    expect(commandReceipt("digest.append", "t9:turn-2")).toBeNull();
  });
});
