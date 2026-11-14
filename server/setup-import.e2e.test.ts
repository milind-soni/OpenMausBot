import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";

// The fixture server's HOME is its own disposable data folder, so the files planted here are the only ones it can find.
const SENTINEL = "SENTINEL-e2e-credential-51c0";

it("is refused on a server that is not the desktop app's own, where any local process is the owner's loopback", async () => {
  const headless = await launchVerificationServer();
  try {
    mkdirSync(join(headless.info.dataDir, ".claude", "skills", "notes"), { recursive: true });
    writeFileSync(join(headless.info.dataDir, ".claude", "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: Takes notes.\n---\n\nWrite it down.\n");
    for (const [method, body] of [["GET", undefined], ["POST", JSON.stringify({ skills: true, tools: true })]] as const) {
      const response = await fetch(`${headless.info.url}/api/setup-import`, {
        method, headers: { "content-type": "application/json", origin: headless.info.url }, ...(body ? { body } : {}),
      });
      expect(response.status, method).toBe(403);
    }
  } finally {
    await headless.close();
  }
});

describe("bringing in another AI tool's setup through the desktop app's own server", () => {
  let fixture: VerificationServer;
  // As the desktop app runs it: every change carries the app's owner capability.
  const owner = randomBytes(32).toString("base64url");
  const realFetch = globalThis.fetch;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text() };
  };
  const put = (path: string, text: string) => {
    const full = join(fixture.info.dataDir, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  /** One turn of `bot` on the fixture Claude: what it was told, how it was launched, and its task folder. */
  const turn = async (bot: { id: string; threadId: string }, text: string) => {
    const url = fixture.info.url;
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text, "--url", url]);
    await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "60", "--url", url]);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { argv: string[]; cwd: string; systemPrompt?: string; prompt?: unknown };
    const linked = (family: string, name: string) => {
      try {
        const link = join(dump.cwd, family, "skills", name);
        // A Windows junction reads back with a \\?\ prefix.
        return lstatSync(link).isSymbolicLink() ? resolve(readlinkSync(link).replace(/^\\\\\?\\/, "")) : "not a link";
      } catch {
        return null;
      }
    };
    return { argv: dump.argv, system: dump.systemPrompt ?? "", message: JSON.stringify(dump.prompt ?? ""), linked };
  };
  const copyOf = (name: string) => resolve(fixture.info.dataDir, "imported-skills", name);

  beforeAll(async () => {
    globalThis.fetch = (input, init = {}) => realFetch(input, { ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), "x-openmausbot-desktop-owner": owner } });
    fixture = await launchVerificationServer({ ...process.env, OMB_TEST_DESKTOP_OWNER_TOKEN: owner });
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await fixture?.close();
  });

  it("finds a skill and an MCP server, keeps one copy of the skill for the first bot and every later one, and adds the server switched off", async () => {
    put(".claude/skills/release-notes/SKILL.md", "---\nname: release-notes\ndescription: Writes release notes from merged changes.\n---\n\nRun scripts/collect.sh first.\n");
    put(".claude/skills/release-notes/scripts/collect.sh", "git log --oneline\n");
    put(".codex/skills/review-pr/SKILL.md", "---\nname: review-pr\ndescription: Reviews a pull request.\n---\n\nRead the diff.\n");
    put(".claude.json", JSON.stringify({
      oauthAccount: { accessToken: SENTINEL },
      mcpServers: { github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_e2e_secret" } } },
    }));
    put(".codex/auth.json", SENTINEL);
    put(".claude/.credentials.json", SENTINEL);

    const found = await api("GET", "/api/setup-import");
    expect(found.status).toBe(200);
    expect(JSON.parse(found.text)).toEqual({
      skills: [{ name: "release-notes", source: "claudeCode" }, { name: "review-pr", source: "codex" }],
      tools: [{ name: "github", source: "claudeCode" }],
    });

    const brought = await api("POST", "/api/setup-import", { skills: true, tools: true });
    expect(brought.status).toBe(200);
    expect(JSON.parse(brought.text)).toEqual({
      skills: { added: ["release-notes", "review-pr"], present: [], skipped: [], filesLeftOut: 0, review: [] },
      tools: { added: ["github"], present: [], skipped: [] },
    });

    // The starter bot the welcome flow names, and a bot made afterwards the way the New bot dialog makes one.
    const starter = (JSON.parse((await api("GET", "/api/bots")).text) as { bots: Array<{ id: string; threadId: string }> }).bots[0]!;
    const later = JSON.parse((await api("POST", "/api/bots", { name: "Later Bot", useDefaults: false, requireAvailableModel: false })).text).bot as { id: string; threadId: string };
    for (const bot of [starter, later]) {
      const skills = await api("GET", `/api/bots/${bot.id}/skills`);
      expect(JSON.parse(skills.text).skills).toEqual([
        expect.objectContaining({ name: "release-notes", enabled: true, source: "~/.claude/skills/release-notes", origin: "imported" }),
        expect.objectContaining({ name: "review-pr", enabled: true, source: "~/.codex/skills/review-pr", origin: "imported" }),
      ]);
      const told = await turn(bot, "Write the release notes");
      expect(told.system).toContain("Skills from this computer:");
      expect(told.system).toContain(`- release-notes: Writes release notes from merged changes. Read ${JSON.stringify(join(copyOf("release-notes"), "SKILL.md"))}.`);
      expect(told.linked(".claude", "release-notes")).toBe(copyOf("release-notes"));
      expect(told.linked(".agents", "review-pr")).toBe(copyOf("review-pr"));
      expect(told.argv).not.toContain("--add-dir");
    }
    // The prompt preview in Bot Settings says the same.
    const preview = JSON.parse((await api("GET", `/api/bots/${later.id}/system-prompt`)).text) as { sections: Array<{ id: string; text: string }> };
    expect(preview.sections.find((section) => section.id === "skills")?.text).toContain("- review-pr: Reviews a pull request.");
    // `/name` runs one too, for a bot that never had it in its own Skills.
    expect((await turn(later, "/review-pr the open change")).message).toContain(
      // `message` is the prompt as JSON, so the sentence appears JSON-escaped (on Windows the path's \ twice over).
      JSON.stringify(`The user ran your review-pr skill with /review-pr. Read ${JSON.stringify(join(copyOf("review-pr"), "SKILL.md"))}`).slice(1, -1),
    );
    const mcp = await api("GET", "/api/mcp/servers");
    expect(JSON.parse(mcp.text).servers).toEqual([
      expect.objectContaining({ name: "github", command: "npx", envKeys: ["GITHUB_TOKEN"], enabled: false }),
    ]);

    expect(JSON.parse((await api("GET", "/api/setup-import")).text)).toEqual({ skills: [], tools: [] });
    for (const said of [found.text, brought.text, mcp.text]) {
      expect(said).not.toContain(SENTINEL);
      expect(said).not.toContain("ghp_e2e_secret");
    }
  });

  it("with Also use my Claude Code skills on, a Claude turn sees each Claude Code skill once, from its own folder", async () => {
    expect((await api("PATCH", "/api/config", { features: { claudeUserSkills: true } })).status).toBe(200);
    const starter = (JSON.parse((await api("GET", "/api/bots")).text) as { bots: Array<{ id: string; threadId: string; name: string }> }).bots
      .find((bot) => bot.name !== "Later Bot")!;
    const told = await turn(starter, "Write them again");
    expect(told.argv).toContain("--add-dir");
    expect(told.system).not.toContain("release-notes");
    expect(told.linked(".claude", "release-notes")).toBeNull();
    // Codex's skill is not in ~/.claude/skills, so Claude still gets that one from this computer.
    expect(told.system).toContain("- review-pr: Reviews a pull request.");
    expect(told.linked(".claude", "review-pr")).toBe(copyOf("review-pr"));
  });

  it("switches a skill from this computer off for one bot only, with the skills library off or on", async () => {
    const bots = (JSON.parse((await api("GET", "/api/bots")).text) as { bots: Array<{ id: string; threadId: string; name: string }> }).bots;
    const later = bots.find((bot) => bot.name === "Later Bot")!;
    const starter = bots.find((bot) => bot !== later)!;
    const switched = await api("PATCH", `/api/bots/${later.id}/skills/review-pr`, { enabled: false });
    expect(switched.status).toBe(200);
    expect(JSON.parse(switched.text).skill).toMatchObject({ name: "review-pr", enabled: false, origin: "imported" });
    const enabled = async (botId: string) => Object.fromEntries((JSON.parse((await api("GET", `/api/bots/${botId}/skills`)).text).skills as Array<{ name: string; enabled: boolean }>)
      .map((skill) => [skill.name, skill.enabled]));
    expect(await enabled(later.id)).toEqual({ "release-notes": true, "review-pr": false });
    expect(await enabled(starter.id)).toEqual({ "release-notes": true, "review-pr": true });
    const told = await turn(later, "Review it");
    expect(told.system).not.toContain("review-pr");
    expect(told.linked(".agents", "review-pr")).toBeNull();
    // There is one copy for all bots: nothing here deletes it.
    expect((await api("DELETE", `/api/bots/${later.id}/skills/review-pr`)).status).toBe(404);
    expect((await api("PATCH", "/api/config", { features: { skillsLibrary: true } })).status).toBe(200);
    expect(await enabled(starter.id)).toEqual({ "release-notes": true, "review-pr": true });
    expect((await api("PATCH", `/api/bots/${later.id}/skills/review-pr`, { enabled: true })).status).toBe(200);
    expect(await enabled(later.id)).toEqual({ "release-notes": true, "review-pr": true });
  });

  it("reaches a bot's room turns too, which run in its own folder: through the index", async () => {
    const bots = (JSON.parse((await api("GET", "/api/bots")).text) as { bots: Array<{ id: string; name: string }> }).bots;
    const later = bots.find((bot) => bot.name === "Later Bot")!;
    const room = JSON.parse((await api("POST", "/api/groups", {
      name: "Release room", memberIds: [later.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: later.id } },
    })).text).group as { id: string };
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Room marker 7c1: review the release" })).status).toBe(202);
    const dumped = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { prompt?: unknown; systemPrompt?: string };
    await expect.poll(() => JSON.stringify(dumped().prompt ?? "").includes("Room marker 7c1"), { timeout: 20_000 }).toBe(true);
    const system = dumped().systemPrompt ?? "";
    expect(system).toContain("Skills from this computer:");
    expect(system).toContain("- review-pr: Reviews a pull request.");
    // "Also use my Claude Code skills" is still on from above: Claude has release-notes from its own folder.
    expect(system).not.toContain("release-notes");
  });
});
