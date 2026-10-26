import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { audienceBrowserSuffix } from "../browser/audience.ts";
import { audienceHome, audienceHomeKey, audienceHomes, homedSpawn } from "./layout.ts";

const linux = describe.skipIf(process.platform === "win32");
const serverHome = "/data", dataDir = "/data/.openmausbot";
const bob = audienceHome(dataDir, "member:p_bob"), owner = audienceHome(dataDir, "member:p_olive");

linux("an audience's engine home", () => {
  it("is keyed like the audience's browser: the team's, a group chat's or a person's, never another's", () => {
    expect(audienceHomeKey("team")).toBe("team");
    expect(audienceHomeKey("member:p_bob")).toBe(audienceBrowserSuffix("member:p_bob").slice(2));
    expect(audienceHomeKey("room:r1")).toMatch(/^room-[0-9a-f]{16}$/);
    expect(audienceHome(dataDir, "team")).toBe("/data/.openmausbot/engine-homes/team");
    expect(new Set([bob, owner, audienceHome(dataDir, "room:r1"), audienceHome(dataDir, "team")]).size).toBe(4);
    expect(bob.startsWith(`${owner}/`) || owner.startsWith(`${bob}/`)).toBe(false);
  });

  it("is the spawn's HOME, with the engines' default folders inside it and the team's sign-ins named from the server's HOME", () => {
    const homed = homedSpawn({ HOME: serverHome, PATH: "/usr/bin", ANTHROPIC_API_KEY: "k" }, { dataDir, serverHome, home: bob });
    expect(homed.env).toEqual({ HOME: bob, PATH: "/usr/bin", ANTHROPIC_API_KEY: "k" });
    expect(homed.home).toBe(bob);
    expect(homed.folders).toEqual([]);
    expect(homed.shared).toContainEqual({ source: "/data/.claude/.credentials.json", target: `${bob}/.claude/.credentials.json` });
    expect(homed.shared).toContainEqual({ source: "/data/.codex/auth.json", target: `${bob}/.codex/auth.json` });
    expect(homed.shared).toContainEqual({ source: "/data/.grok/auth.json", target: `${bob}/.grok/auth.json` });
    expect(homed.shared).toContainEqual({ source: "/data/.local/share/opencode/auth.json", target: `${bob}/.local/share/opencode/auth.json` });
    // Transcripts and session state are never shared: only sign-in files are named.
    for (const file of homed.shared) expect(file.target).not.toMatch(/projects|sessions|history/);
    expect(homed.shared.every((file) => file.target.startsWith(`${bob}/`))).toBe(true);
  });

  it("moves an engine folder the environment names: in the server's HOME to the same place, elsewhere to one of its own", () => {
    const plan = join(dataDir, "providers", "chatgpt-plan", "abc", "codex");
    const homed = homedSpawn({ HOME: serverHome, CLAUDE_CONFIG_DIR: "/data/.claude-work", CODEX_HOME: plan, XDG_CACHE_HOME: "/var/cache/x", GROK_HOME: "relative/grok" },
      { dataDir, serverHome, home: bob });
    expect(homed.env.CLAUDE_CONFIG_DIR).toBe(`${bob}/.claude-work`);
    expect(homed.env.CODEX_HOME).toMatch(new RegExp(`^${bob}/\\.omb-folders/CODEX_HOME-[0-9a-f]{12}$`));
    expect(homed.env.XDG_CACHE_HOME).toMatch(new RegExp(`^${bob}/\\.omb-folders/XDG_CACHE_HOME-[0-9a-f]{12}$`));
    expect(homed.env.GROK_HOME).toBe("relative/grok");
    expect(homed.folders).toEqual(expect.arrayContaining([`${bob}/.claude-work`, homed.env.CODEX_HOME, homed.env.XDG_CACHE_HOME]));
    expect(homed.shared).toContainEqual({ source: "/data/.claude-work/.credentials.json", target: `${bob}/.claude-work/.credentials.json` });
    expect(homed.shared).toContainEqual({ source: `${plan}/auth.json`, target: `${homed.env.CODEX_HOME}/auth.json` });
    // The same folder in two audiences lands in each one's own home.
    const other = homedSpawn({ HOME: serverHome, CODEX_HOME: plan }, { dataDir, serverHome, home: owner });
    expect(other.env.CODEX_HOME!.slice(owner.length)).toBe(homed.env.CODEX_HOME!.slice(bob.length));
  });

  it("an environment already in an engine home is the server's again, so nothing is moved twice", () => {
    const once = homedSpawn({ HOME: serverHome, CLAUDE_CONFIG_DIR: "/data/.claude-work" }, { dataDir, serverHome, home: bob });
    const twice = homedSpawn(once.env, { dataDir, serverHome, home: bob });
    expect(twice.env).toEqual(once.env);
    expect(twice.shared).toContainEqual({ source: "/data/.codex/auth.json", target: `${bob}/.codex/auth.json` });
    expect(twice.shared.filter((file) => file.source.startsWith(`${dataDir}/engine-homes/`))).toEqual([]);
  });
});

describe("the audience homes made so far", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-engine-homes-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  it("are the team's, the group chats' and the people's, never the held folder or anything else there", () => {
    for (const name of ["team", `member-${"a".repeat(16)}`, `room-${"b".repeat(16)}`, ".held", ".migrated-x", "member-xyz"]) mkdirSync(join(root, "engine-homes", name), { recursive: true });
    expect(audienceHomes(root).map((dir) => dir.slice(join(root, "engine-homes").length + 1)).sort()).toEqual([`member-${"a".repeat(16)}`, `room-${"b".repeat(16)}`, "team"]);
  });
});
