import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as atomic from "./atomic.ts";
import { CommandAllowlistStore, commandAllowlistCandidate, validateCommandAllowlistCandidate } from "./command-allowlist.ts";

let directory: string;
let filename: string;
const candidate = () => ({ command: "git status --short", cwd: directory, providerInstanceId: "claude" });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omb-command-rules-"));
  filename = join(directory, "command-allowlist.json");
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("command allowlist", () => {
  it("persists private rules, deduplicates exact scope and returns detached public records", () => {
    const store = new CommandAllowlistStore(filename);
    expect(store.list("bot-a")).toEqual([]);
    const rule = store.add("bot-a", candidate());
    expect(store.add("bot-a", candidate())).toEqual(rule);
    expect(store.list("bot-a")).toEqual([rule]);
    expect(store.list("bot-a")[0]).not.toHaveProperty("botId");
    rule.command = "other command";
    store.list("bot-a")[0]!.cwd = "changed";
    const restarted = new CommandAllowlistStore(filename);
    expect(restarted.matches("bot-a", candidate())).toBe(true);
    expect(store.matches("bot-a", candidate())).toBe(true);
    expect(restarted.list("bot-a")).toHaveLength(1);
    if (process.platform !== "win32") expect(statSync(filename).mode & 0o777).toBe(0o600);
  });

  it("requires the complete command, directory, provider instance and bot to match", () => {
    const store = new CommandAllowlistStore(filename);
    store.add("bot-a", candidate());
    expect(store.matches("bot-b", candidate())).toBe(false);
    for (const changed of [
      { command: "git status --short && git push" },
      { command: "git status --short\ngit push" },
      { command: "git status --short " },
      { command: "git status" },
      { command: "git*" },
      { cwd: join(directory, "other") },
      { providerInstanceId: "claude-other" },
    ]) expect(store.matches("bot-a", { ...candidate(), ...changed })).toBe(false);
    store.add("bot-a", { ...candidate(), command: "echo *.ts" });
    expect(store.matches("bot-a", { ...candidate(), command: "echo *.ts" })).toBe(true);
    expect(store.matches("bot-a", { ...candidate(), command: "echo file.ts" })).toBe(false);
  });

  it("persists revocations and cannot remove a different bot's rule", () => {
    const store = new CommandAllowlistStore(filename);
    const a = store.add("bot-a", candidate());
    const b = store.add("bot-b", candidate());
    expect(store.remove("bot-a", b.id)).toBe(false);
    expect(store.remove("bot-a", a.id)).toBe(true);
    expect(new CommandAllowlistStore(filename).matches("bot-a", candidate())).toBe(false);
    expect(store.matches("bot-b", candidate())).toBe(true);
    store.clear("bot-b");
    expect(new CommandAllowlistStore(filename).list("bot-b")).toEqual([]);
  });

  it("preserves directory spelling and never resolves symlinks", () => {
    const store = new CommandAllowlistStore(filename);
    store.add("bot-a", { ...candidate(), cwd: `${directory}${sep}.${sep}` });
    expect(store.matches("bot-a", candidate())).toBe(false);
    expect(store.matches("bot-a", { ...candidate(), cwd: `${directory}${sep}.${sep}` })).toBe(true);
    const target = join(directory, "real");
    const link = join(directory, "link");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    store.add("bot-a", { ...candidate(), cwd: link });
    expect(store.matches("bot-a", { ...candidate(), cwd: target })).toBe(false);
    expect(commandAllowlistCandidate({ ...candidate(), cwd: `${link}${sep}..` })).toBeNull();
    expect(validateCommandAllowlistCandidate({ ...candidate(), cwd: parse(directory).root }).cwd).toBe(parse(directory).root);
  });

  it("uses native absolute paths and refuses Windows drive-relative paths", () => {
    const native = process.platform === "win32" ? "C:\\work\\project" : "/work/project";
    expect(validateCommandAllowlistCandidate({ ...candidate(), cwd: native }).cwd).toBe(native);
    expect(commandAllowlistCandidate({ ...candidate(), cwd: "C:project" })).toBeNull();
    if (process.platform === "win32") {
      expect(commandAllowlistCandidate({ ...candidate(), cwd: "\\project" })).toBeNull();
      expect(validateCommandAllowlistCandidate({ ...candidate(), cwd: "C:/work/project/" }).cwd).toBe("C:/work/project/");
      expect(validateCommandAllowlistCandidate({ ...candidate(), cwd: "\\\\server\\share\\project" }).cwd).toBe("\\\\server\\share\\project");
    }
  });

  it("rejects malformed, empty, excessive and secret-bearing candidate data", () => {
    for (const bad of [
      null, [], {}, { ...candidate(), command: " " }, { ...candidate(), command: 42 },
      { ...candidate(), command: "x".repeat(16_385) }, { ...candidate(), command: "🙂".repeat(4_097) },
      { ...candidate(), command: "git\0status" }, { ...candidate(), command: "\ud800" },
      { ...candidate(), cwd: "relative/path" }, { ...candidate(), cwd: null },
      { ...candidate(), cwd: `${directory}${sep}${"x".repeat(4097)}` },
      { ...candidate(), cwd: `${directory}\nother` },
      { ...candidate(), providerInstanceId: "" }, { ...candidate(), providerInstanceId: " claude" },
      { ...candidate(), providerInstanceId: "x".repeat(201) },
      { ...candidate(), command: "curl --token fixture-secret" },
      { ...candidate(), command: "TOKEN=fixturesecret curl https://example.test" },
      { ...candidate(), command: "curl https://user:fixturesecret@example.test" },
    ]) {
      expect(() => validateCommandAllowlistCandidate(bad)).toThrow();
      expect(commandAllowlistCandidate(bad)).toBeNull();
    }
    const multiline = { ...candidate(), command: "printf 'hello'\nprintf 'world'\n" };
    expect(validateCommandAllowlistCandidate(multiline).command).toBe(multiline.command);
    expect(validateCommandAllowlistCandidate({ ...candidate(), command: "curl -H \"Authorization: Bearer $TOKEN\" https://example.test" }).command).toContain("$TOKEN");
  });

  it("fails closed for corrupt, malformed or unreadable stores without replacing them", () => {
    const store = new CommandAllowlistStore(filename);
    store.add("bot-a", candidate());
    const valid = JSON.parse(readFileSync(filename, "utf8"));
    for (const text of [
      "{broken", JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, rules: [...valid.rules, { ...valid.rules[0], id: "bad-id" }] }),
      JSON.stringify({ ...valid, rules: [{ ...valid.rules[0], command: "curl --password secret" }] }),
    ]) {
      writeFileSync(filename, text);
      const damaged = new CommandAllowlistStore(filename);
      expect(damaged.matches("bot-a", candidate())).toBe(false);
      expect(damaged.list("bot-a")).toEqual([]);
      expect(() => damaged.add("bot-a", candidate())).toThrow(/could not be read/);
      expect(() => damaged.clear("bot-a")).toThrow(/could not be read/);
      expect(readFileSync(filename, "utf8")).toBe(text);
    }
    expect(new CommandAllowlistStore(directory).matches("bot-a", candidate())).toBe(false);
  });

  it("does not activate a grant or claim a revocation when its atomic write fails", () => {
    const store = new CommandAllowlistStore(filename);
    const rule = store.add("bot-a", candidate());
    const saved = readFileSync(filename, "utf8");
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw new Error("fixture disk full"); });
    const another = { ...candidate(), command: "git diff" };
    expect(() => store.add("bot-a", another)).toThrow(/fixture disk full/);
    expect(store.matches("bot-a", another)).toBe(false);
    expect(() => store.remove("bot-a", rule.id)).toThrow(/fixture disk full/);
    expect(() => store.clear("bot-a")).toThrow(/fixture disk full/);
    expect(store.matches("bot-a", candidate())).toBe(true);
    expect(readFileSync(filename, "utf8")).toBe(saved);
    expect(new CommandAllowlistStore(filename).list("bot-a")).toEqual([rule]);
  });
});
