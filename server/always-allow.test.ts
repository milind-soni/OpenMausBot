import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dropRemovedGrants, MAX_ALWAYS_ALLOW, recoverThreadGrantsOnce, rewriteGrantLists, withAlwaysAllowKey, type GrantRewrite } from "./always-allow.ts";

const full = Array.from({ length: MAX_ALWAYS_ALLOW }, (_, i) => `provider-tool:claude:linear:tool_${i}:0123456789abcdef`);

describe("adding an Always allow grant", () => {
  it("adds a new key once and keeps the ones already there", () => {
    expect(withAlwaysAllowKey(undefined, "Read")).toEqual(["Read"]);
    expect(withAlwaysAllowKey(["Read"], "Grep")).toEqual(["Read", "Grep"]);
    expect(withAlwaysAllowKey(["Read", "Grep"], "Read")).toEqual(["Read", "Grep"]);
  });

  it("refuses a new key when the list is full instead of dropping it", () => {
    expect(withAlwaysAllowKey(full.slice(1), full[0])).toHaveLength(MAX_ALWAYS_ALLOW);
    expect(withAlwaysAllowKey(full, "provider-tool:claude:linear:one_more:0123456789abcdef")).toBeNull();
  });

  it("still accepts a key that is already on a full list", () => {
    expect(withAlwaysAllowKey(full, full[7])).toEqual(full);
  });
});

describe("recovering a bot's grants from its threads", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const folder = () => { const dir = mkdtempSync(join(tmpdir(), "omb-always-allow-")); dirs.push(dir); return dir; };
  const inThreads = Array.from({ length: 30 }, (_, i) => `provider-tool:claude:notes:read_${i}:0123456789abcdef`);

  it("adds a thread's tool grants to the bot's own, each once, never its shell grants, and says nothing while there is room", () => {
    const log = vi.fn();
    const bot = { id: "bot-1", alwaysAllow: ["Read", inThreads[0]!], tasks: [{ alwaysAllow: [inThreads[2]!, "Bash:git status"] }, { alwaysAllow: [inThreads[1]!, inThreads[0]!] }, {}] };
    const untouched = { id: "bot-2", alwaysAllow: ["Read"], tasks: [{ alwaysAllow: ["Bash:ls"] }] };
    expect(recoverThreadGrantsOnce(folder(), [bot, untouched], log)).toBe(true);
    expect(bot.alwaysAllow).toEqual(["Read", inThreads[0], inThreads[2], inThreads[1]]);
    expect(bot.tasks[0]!.alwaysAllow).toEqual([inThreads[2], "Bash:git status"]);
    expect(untouched).toEqual({ id: "bot-2", alwaysAllow: ["Read"], tasks: [{ alwaysAllow: ["Bash:ls"] }] });
    expect(log).not.toHaveBeenCalled();
  });

  it("runs once for a data folder, so a grant removed since is not brought back from a thread that still holds a copy", () => {
    const dir = folder();
    const bot = { id: "bot-1", alwaysAllow: [] as string[], tasks: [{ alwaysAllow: [inThreads[0]!] }] };
    expect(recoverThreadGrantsOnce(dir, [bot])).toBe(true);
    expect(bot.alwaysAllow).toEqual([inThreads[0]]);
    expect(existsSync(join(dir, "always-allow-recovered"))).toBe(true);
    bot.alwaysAllow = [];
    expect(recoverThreadGrantsOnce(dir, [bot]), "the next start").toBe(false);
    expect(bot.alwaysAllow).toEqual([]);
    expect(recoverThreadGrantsOnce(folder(), [{ id: "bot-3", alwaysAllow: ["Read"], tasks: [] }]), "nothing to recover is still marked done").toBe(false);
  });

  it("keeps every grant the bot already has when its threads hold more than fit, says how many were kept once, and leaves no thread allowing the rest", () => {
    const log = vi.fn();
    const dir = folder();
    const own = full.slice(10);
    const bot = { id: "bot-1", alwaysAllow: [...own], tasks: [{ alwaysAllow: [...inThreads.slice(0, 15), "Bash:ls"] }, { alwaysAllow: inThreads.slice(15) }] };
    expect(recoverThreadGrantsOnce(dir, [bot], log)).toBe(true);
    expect(bot.alwaysAllow).toEqual([...own, ...inThreads.slice(0, 10)]);
    expect(bot.tasks[0]!.alwaysAllow, "what did not fit asks again in its thread too; its shell grant stays").toEqual([...inThreads.slice(0, 10), "Bash:ls"]);
    expect(bot.tasks[1]!.alwaysAllow).toEqual([]);
    expect(log).toHaveBeenCalledExactlyOnceWith("[always-allow] bot bot-1: kept 200 of 220 always-allowed tools (the limit is 200); the other 20 ask again.");
    expect(recoverThreadGrantsOnce(dir, [bot], log)).toBe(false);
    expect(log).toHaveBeenCalledOnce();
  });

  it("keeps the newest of a list that was already past the limit", () => {
    const log = vi.fn();
    const bot = { id: "bot-1", alwaysAllow: [...inThreads.slice(0, 5), ...full], tasks: [{ alwaysAllow: inThreads.slice(0, 6) }] };
    expect(recoverThreadGrantsOnce(folder(), [bot], log)).toBe(true);
    expect(bot.alwaysAllow).toEqual(full);
    expect(bot.tasks[0]!.alwaysAllow).toEqual([]);
    expect(log).toHaveBeenCalledExactlyOnceWith("[always-allow] bot bot-1: kept 200 of 206 always-allowed tools (the limit is 200); the other 6 ask again.");
  });
});

describe("removing a grant in Settings", () => {
  const fixture = () => {
    const bot = { id: "iris", alwaysAllow: ["A", "B", "C"], tasks: [{ alwaysAllow: ["A", "B", "Bash:ls"] }, { alwaysAllow: ["C"] }, { alwaysAllow: [] as string[] }, {}] as Array<{ alwaysAllow?: string[] }> };
    const saves = vi.fn();
    const store = { bot: (id: string) => (id === "iris" ? bot : null), rewriteGrants: (id: string, rewrite: GrantRewrite, removal?: boolean) => id === "iris" && rewriteGrantLists(bot, rewrite, saves, removal) };
    return { bot, saves, store };
  };

  it("takes it from every thread of the bot and its running turns in one save, and from no other bot's turn", () => {
    const { bot, saves, store } = fixture();
    const turns = [{ id: "iris", alwaysAllow: ["B", "C"] }, { id: "paul", alwaysAllow: ["B"] }, { id: "iris" }];
    dropRemovedGrants(store, turns, "iris", ["A", "C"]);
    expect(bot).toEqual({ id: "iris", alwaysAllow: ["A", "C"], tasks: [{ alwaysAllow: ["A", "Bash:ls"] }, { alwaysAllow: ["C"] }, { alwaysAllow: [] }, {}] });
    expect(turns).toEqual([{ id: "iris", alwaysAllow: ["C"] }, { id: "paul", alwaysAllow: ["B"] }, { id: "iris" }]);
    expect(saves).toHaveBeenCalledOnce();
  });

  it("does nothing when the new list only adds or reorders", () => {
    const { bot, saves, store } = fixture();
    dropRemovedGrants(store, [], "iris", ["C", "B", "A", "D"]);
    dropRemovedGrants(store, [], "nobody", []);
    expect(bot.tasks[0]!.alwaysAllow).toEqual(["A", "B", "Bash:ls"]);
    expect(saves).not.toHaveBeenCalled();
  });

  it("keeps the removal in force, in threads and running turns, when it could not be saved", () => {
    const { bot, saves, store } = fixture();
    saves.mockImplementation(() => { throw new Error("fixture disk full"); });
    const turns = [{ id: "iris", alwaysAllow: ["A", "B"] }];
    expect(() => dropRemovedGrants(store, turns, "iris", ["C"])).toThrow("fixture disk full");
    expect(bot.alwaysAllow).toEqual(["C"]);
    expect(bot.tasks.map((task) => task.alwaysAllow)).toEqual([["Bash:ls"], ["C"], [], undefined]);
    expect(turns[0]!.alwaysAllow).toEqual([]);
  });
});
