import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keepChatsOutOfCodexHistory, linkSharedCodexHome } from "./codex-shared-home.ts";

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
  it("links the person's Codex home into the plan's, but never its sign-in, chats, local folders or SQLite journals", () => {
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
    write(join(shared, "session_index.jsonl"));
    write(join(shared, "logs_2.sqlite"));
    for (const folder of ["log", "memories", "tmp", "sessions", "archived_sessions", "shell_snapshots", "thread-writer-locks"]) mkdirSync(join(shared, folder), { recursive: true });

    expect(linkSharedCodexHome(shared, plan)).toBe(true);

    for (const name of ["config.toml", "skills", ".credentials.json", "plugins", "mcp-oauth-locks"]) {
      expect(linksTo(join(plan, name), join(shared, name)), name).toBe(true);
    }
    expect(readFileSync(join(plan, "skills", "review", "SKILL.md"), "utf8")).toBe("x");
    // Chats the plan starts stay in its own home, out of the person's Codex and ChatGPT apps.
    write(join(plan, "sessions", "2026", "rollout.jsonl"));
    expect(existsSync(join(shared, "sessions", "2026", "rollout.jsonl"))).toBe(false);
    for (const name of ["auth.json", "auth.lock", "models_cache.json", "log", "memories", "tmp", "state_5.sqlite-wal", "state_5.sqlite-shm", "history.jsonl",
      "session_index.jsonl", "state_5.sqlite", "logs_2.sqlite", "archived_sessions", "shell_snapshots", "thread-writer-locks"]) {
      expect(existsSync(join(plan, name)), name).toBe(false);
    }
  });

  it("removes links to the person's chats from before, and leaves the chats themselves where they are", () => {
    write(join(shared, "sessions", "2026", "rollout-person.jsonl"), "person's chat");
    write(join(shared, "history.jsonl"), "person's history");
    write(join(shared, "state_5.sqlite"), "person's chat list");
    write(join(shared, "config.toml"), "person's config");
    mkdirSync(plan, { recursive: true });
    for (const name of ["sessions", "history.jsonl", "state_5.sqlite", "config.toml"]) symlinkSync(join(shared, name), join(plan, name));
    symlinkSync(join(root, "gone", "archived_sessions"), join(plan, "archived_sessions"));

    linkSharedCodexHome(shared, plan);

    for (const name of ["sessions", "history.jsonl", "state_5.sqlite", "archived_sessions"]) expect(() => lstatSync(join(plan, name)), name).toThrow();
    expect(linksTo(join(plan, "config.toml"), join(shared, "config.toml"))).toBe(true);
    expect(readFileSync(join(shared, "sessions", "2026", "rollout-person.jsonl"), "utf8")).toBe("person's chat");
    expect(readFileSync(join(shared, "history.jsonl"), "utf8")).toBe("person's history");
    expect(readFileSync(join(shared, "state_5.sqlite"), "utf8")).toBe("person's chat list");
  });

  it("removes links to the person's chats even when their home cannot be shared", () => {
    write(join(shared, "sessions", "2026", "rollout-person.jsonl"), "person's chat");
    write(join(shared, "mcp-oauth-locks"), "a file where a shared folder should be");
    mkdirSync(plan, { recursive: true });
    symlinkSync(join(shared, "sessions"), join(plan, "sessions"));

    expect(linkSharedCodexHome(shared, plan)).toBe(false);

    expect(() => lstatSync(join(plan, "sessions"))).toThrow();
    expect(readFileSync(join(shared, "sessions", "2026", "rollout-person.jsonl"), "utf8")).toBe("person's chat");
  });

  it("links the person's own login into a home that uses it, and says when it cannot", () => {
    write(join(shared, "auth.json"), "person's sign-in");
    write(join(shared, "models_cache.json"), "person's models");
    write(join(shared, "history.jsonl"));

    expect(linkSharedCodexHome(shared, plan, "person")).toBe(true);
    for (const name of ["auth.json", "models_cache.json"]) expect(linksTo(join(plan, name), join(shared, name)), name).toBe(true);
    expect(existsSync(join(plan, "history.jsonl"))).toBe(false);
    // A refreshed login written through the link is the person's own file.
    writeFileSync(join(plan, "auth.json"), "refreshed");
    expect(readFileSync(join(shared, "auth.json"), "utf8")).toBe("refreshed");

    const copied = join(root, "copied", "codex");
    write(join(copied, "auth.json"), "a login of its own");
    expect(linkSharedCodexHome(shared, copied, "person")).toBe(false);
    expect(readFileSync(join(copied, "auth.json"), "utf8")).toBe("a login of its own");

    const signedOut = join(root, "signed-out", ".codex");
    write(join(signedOut, "config.toml"));
    expect(linkSharedCodexHome(signedOut, join(root, "fresh", "codex"), "person")).toBe(true);
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
    write(join(plan, "mcp-oauth-locks", "server.lock"));
    write(join(plan, "config.toml"), "plan config");
    write(join(shared, "config.toml"), "person config");

    linkSharedCodexHome(shared, plan);

    expect(isLink(join(plan, "sessions"))).toBe(false);
    expect(readFileSync(join(plan, "sessions", "2026", "11", "rollout-plan.jsonl"), "utf8")).toBe("plan session");
    expect(readFileSync(join(plan, "history.jsonl"), "utf8")).toBe("plan history");
    expect(readFileSync(join(shared, "history.jsonl"), "utf8")).toBe("person");
    // Codex's bundled .system skills and an empty folder are rebuilt; the person's skills take their place.
    expect(linksTo(join(plan, "skills"), join(shared, "skills"))).toBe(true);
    expect(linksTo(join(plan, "plugins"), join(shared, "plugins"))).toBe(true);
    expect(readFileSync(join(plan, "thread-writer-locks", "thread-1.lock"), "utf8")).toBe("x");
    expect(readFileSync(join(plan, "config.toml"), "utf8")).toBe("plan config");
    // A lock still in the plan's own folder may guard a live writer: shared on a later turn, once released.
    expect(isLink(join(plan, "mcp-oauth-locks"))).toBe(false);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain("keeps its own mcp-oauth-locks, config.toml from earlier turns");

    rmSync(join(plan, "mcp-oauth-locks", "server.lock"));
    linkSharedCodexHome(shared, plan);
    expect(linksTo(join(plan, "mcp-oauth-locks"), join(shared, "mcp-oauth-locks"))).toBe(true);
    expect(isLink(join(plan, "thread-writer-locks"))).toBe(false);
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

describe("keepChatsOutOfCodexHistory", () => {
  const data = () => join(root, "data");
  const mausHome = (instanceId: string) => join(data(), "providers", "codex-own", createHash("sha256").update(instanceId).digest("hex"), "codex");
  const turnEnv = (extra: Record<string, string> = {}, teamCloud = false, managed: string[] = []) => {
    const env: Record<string, string | undefined> = { HOME: join(root, "person"), ...extra };
    keepChatsOutOfCodexHistory(env, "codex", data(), teamCloud, managed);
    return env;
  };

  it("runs a turn on the person's own login in MausBot's Codex home, with their login and setup linked in", () => {
    write(join(shared, "auth.json"), "person's sign-in");
    write(join(shared, "config.toml"), 'model = "gpt-5"\n');
    expect(turnEnv()).toMatchObject({ CODEX_HOME: mausHome("codex"), CODEX_SQLITE_HOME: mausHome("codex") });
    expect(linksTo(join(mausHome("codex"), "auth.json"), join(shared, "auth.json"))).toBe(true);
    expect(linksTo(join(mausHome("codex"), "config.toml"), join(shared, "config.toml"))).toBe(true);
    expect(turnEnv({ CODEX_HOME: shared, CODEX_SQLITE_HOME: join(root, "elsewhere") }).CODEX_SQLITE_HOME).toBe(mausHome("codex"));
  });

  it("keeps the person's home when the login may be in the keyring, cannot be linked, or the home is MausBot's already", () => {
    write(join(shared, "auth.json"), "person's sign-in");
    write(join(shared, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    expect(turnEnv().CODEX_HOME).toBeUndefined();
    write(join(shared, "config.toml"), "cli_auth_credentials_store = 'auto'\n");
    expect(turnEnv().CODEX_HOME).toBeUndefined();
    // Only a top-level setting moves the login: one inside a table is about something else.
    write(join(shared, "config.toml"), '[profiles.work]\ncli_auth_credentials_store = "keyring"\n');
    expect(turnEnv().CODEX_HOME).toBe(mausHome("codex"));

    expect(turnEnv({}, true).CODEX_HOME).toBeUndefined();
    const engineHome = join(data(), "engine-homes", "team", ".codex");
    write(join(engineHome, "auth.json"));
    expect(turnEnv({ CODEX_HOME: engineHome }).CODEX_HOME).toBe(engineHome);

    rmSync(mausHome("codex"), { recursive: true });
    write(join(mausHome("codex"), "auth.json"), "a login of its own");
    expect(turnEnv().CODEX_HOME).toBeUndefined();
  });

  it("keeps the person's home when it has no login file or a system-wide setting may put the login in the keyring", () => {
    write(join(shared, "config.toml"), 'model = "gpt-5"\n');
    expect(turnEnv().CODEX_HOME).toBeUndefined();
    expect(existsSync(mausHome("codex"))).toBe(false);

    write(join(shared, "auth.json"), "person's sign-in");
    const managed = join(root, "etc", "codex", "requirements.toml");
    write(managed, 'cli_auth_credentials_store = "keyring"\n');
    expect(turnEnv({}, false, [managed, join(root, "etc", "codex", "missing.toml")]).CODEX_HOME).toBeUndefined();
    write(managed, 'allowed_sandbox_modes = ["read-only"]\n');
    expect(turnEnv({}, false, [managed]).CODEX_HOME).toBe(mausHome("codex"));
  });

  it("keeps the person's home, and the turn going, when MausBot's Codex home cannot be made", () => {
    write(join(shared, "auth.json"), "person's sign-in");
    write(join(data(), "providers", "codex-own"), "a file where a folder should be");
    let env: Record<string, string | undefined> = {};
    expect(() => { env = turnEnv(); }).not.toThrow();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.CODEX_SQLITE_HOME).toBeUndefined();
  });
});
