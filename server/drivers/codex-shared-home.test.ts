import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { linkSharedCodexHome } from "./codex-shared-home.ts";

let root: string;
let shared: string;
let plan: string;

function write(path: string, text = "x"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const isLink = (path: string) => lstatSync(path).isSymbolicLink();
const linksTo = (path: string, target: string) => isLink(path) && realpathSync(path) === realpathSync(target);
const snapshot = () => Object.fromEntries(readdirSync(plan).sort().map(name => [name, isLink(join(plan, name)) ? readlinkSync(join(plan, name)) : "real"]));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omb-codex-shared-home-"));
  shared = join(root, "person", ".codex");
  plan = join(root, "data", "providers", "chatgpt-plan", "abc", "codex");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("linkSharedCodexHome", () => {
  it("links the person's Codex home into the plan's, but never its sign-in, local folders or SQLite journals", () => {
    write(join(shared, "config.toml"), '[mcp_servers.notes]\ncommand = "notes"\n');
    write(join(shared, "skills", "review", "SKILL.md"));
    write(join(shared, "history.jsonl"));
    write(join(shared, ".credentials.json"));
    write(join(shared, "state_5.sqlite"));
    write(join(shared, "state_5.sqlite-wal"));
    write(join(shared, "state_5.sqlite-shm"));
    write(join(shared, "auth.json"), "person's sign-in");
    write(join(shared, "auth.lock"));
    write(join(shared, "models_cache.json"));
    for (const local of ["log", "memories", "tmp"]) mkdirSync(join(shared, local), { recursive: true });

    linkSharedCodexHome(shared, plan);

    for (const name of ["config.toml", "skills", "history.jsonl", ".credentials.json", "state_5.sqlite", "sessions", "plugins", "thread-writer-locks"]) {
      expect(linksTo(join(plan, name), join(shared, name)), name).toBe(true);
    }
    // The shared folders exist in the person's home from the first turn, so what the plan writes lands there.
    expect(lstatSync(join(shared, "sessions")).isDirectory()).toBe(true);
    write(join(plan, "sessions", "2026", "rollout.jsonl"));
    expect(existsSync(join(shared, "sessions", "2026", "rollout.jsonl"))).toBe(true);
    expect(readFileSync(join(plan, "skills", "review", "SKILL.md"), "utf8")).toBe("x");
    for (const name of ["auth.json", "auth.lock", "models_cache.json", "log", "memories", "tmp", "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
      expect(existsSync(join(plan, name)), name).toBe(false);
    }
  });

  it("keeps the plan's own sign-in real and removes a link that stands in its place", () => {
    write(join(shared, "auth.json"), "person's sign-in");
    write(join(shared, "models_cache.json"), "person's models");
    write(join(plan, "auth.json"), "plan sign-in");
    symlinkSync(join(shared, "models_cache.json"), join(plan, "models_cache.json"));
    symlinkSync(join(shared, "auth.lock"), join(plan, "auth.lock"));

    linkSharedCodexHome(shared, plan);

    expect(isLink(join(plan, "auth.json"))).toBe(false);
    expect(readFileSync(join(plan, "auth.json"), "utf8")).toBe("plan sign-in");
    expect(existsSync(join(plan, "models_cache.json"))).toBe(false);
    expect(() => lstatSync(join(plan, "auth.lock"))).toThrow();
    expect(readFileSync(join(shared, "models_cache.json"), "utf8")).toBe("person's models");
  });

  it("keeps what earlier plan turns made, and lets only folders Codex rebuilds itself give way", () => {
    write(join(shared, "history.jsonl"), "person");
    write(join(shared, "skills", "review", "SKILL.md"));
    write(join(plan, "sessions", "2026", "11", "rollout-plan.jsonl"), "plan session");
    write(join(plan, "history.jsonl"), "plan history");
    write(join(plan, "skills", ".system", "openai-docs", "SKILL.md"));
    mkdirSync(join(plan, "plugins"), { recursive: true });
    write(join(plan, "thread-writer-locks", "thread-1.lock"));
    write(join(plan, "mcp-oauth-locks", ".coordination.lock"));

    linkSharedCodexHome(shared, plan);

    expect(isLink(join(plan, "sessions"))).toBe(false);
    expect(readFileSync(join(plan, "sessions", "2026", "11", "rollout-plan.jsonl"), "utf8")).toBe("plan session");
    expect(readFileSync(join(plan, "history.jsonl"), "utf8")).toBe("plan history");
    expect(readFileSync(join(shared, "history.jsonl"), "utf8")).toBe("person");
    // Codex's bundled .system skills and an empty folder are rebuilt; the person's skills take their place.
    expect(linksTo(join(plan, "skills"), join(shared, "skills"))).toBe(true);
    expect(linksTo(join(plan, "plugins"), join(shared, "plugins"))).toBe(true);
    // A lock still in the plan's own folder may guard a live writer: shared on a later turn, once released.
    expect(isLink(join(plan, "thread-writer-locks"))).toBe(false);
    expect(linksTo(join(plan, "mcp-oauth-locks"), join(shared, "mcp-oauth-locks"))).toBe(true);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain("sessions, thread-writer-locks, history.jsonl");

    rmSync(join(plan, "thread-writer-locks", "thread-1.lock"));
    linkSharedCodexHome(shared, plan);
    expect(linksTo(join(plan, "thread-writer-locks"), join(shared, "thread-writer-locks"))).toBe(true);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("changes nothing on a second run, and repoints a link the person's home moved away from", () => {
    write(join(shared, "config.toml"));
    write(join(shared, "skills", "review", "SKILL.md"));
    linkSharedCodexHome(shared, plan);
    const first = snapshot();
    linkSharedCodexHome(shared, plan);
    expect(snapshot()).toEqual(first);

    const moved = join(root, "elsewhere", ".codex");
    write(join(moved, "config.toml"), "moved");
    linkSharedCodexHome(moved, plan);
    expect(linksTo(join(plan, "config.toml"), join(moved, "config.toml"))).toBe(true);
    expect(readFileSync(join(plan, "config.toml"), "utf8")).toBe("moved");
    expect(existsSync(join(shared, "config.toml"))).toBe(true);
  });

  it("only makes the plan home when there is no separate absolute home to share", () => {
    write(join(plan, "config.toml"), "plan");
    for (const home of [null, "relative/.codex", plan, dirname(plan), join(plan, "inner")]) linkSharedCodexHome(home, plan);
    expect(readdirSync(plan)).toEqual(["config.toml"]);
    expect(existsSync(join(plan, "inner"))).toBe(false);

    const fresh = join(root, "fresh", "codex");
    linkSharedCodexHome(null, fresh);
    expect(readdirSync(fresh)).toEqual([]);
  });
});
