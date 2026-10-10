import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { parseBotPackage } from "./bot-package.ts";

it("transfers only selected skills disabled, preserves originals, and rolls back failed installation", async () => {
  const fixture = await launchVerificationServer();
  console.log(JSON.stringify({ fixture: fixture.info }));
  const url = fixture.info.url;
  const post = (path: string, body: unknown) => request(path, { method: "POST", body: JSON.stringify(body) }, url);
  const command = (...args: string[]) => runControlOmb([...args, "--url", url]);
  const instructions = (name: string, body: string) => `---\nname: ${name}\ndescription: Fixture instructions.\n---\n${body}\n`;
  const sharedText = instructions("source-check", "SHARED_SKILL_FIXTURE_MARKER");
  const privateText = instructions("private-notes", "PRIVATE_SKILL_FIXTURE_MARKER");
  const document = {
    format: "openmaus.package", version: 1,
    package: {
      id: "skill-transfer", release: "1.0.0", name: "Skill transfer probe",
      tagline: "Isolated skill transfer.", summary: "Review imported skills before enabling.",
      category: "Testing", author: { name: "Fixture" }, license: "MIT",
      outcomes: ["Keep skills inert."], setupMinutes: 2, requirements: { apps: [], capabilities: [] },
      agents: [{ key: "reviewer", name: "Package skill probe", appearance: { color: "cyan" },
        skills: ["source-check", "private-notes"] }],
      skills: { version: 1, entries: [
        { name: "source-check", description: "Fixture instructions.", source: "package:fixture", instructions: sharedText, enabled: true },
        { name: "private-notes", description: "Fixture instructions.", instructions: privateText },
      ] },
    },
  };
  try {
    expect(await command("doctor")).toMatchObject({ ok: true });
    const before = await request("/api/bots", {}, url);
    const workspaces = join(fixture.info.dataDir, "workspaces");
    const beforeWorkspaces = existsSync(workspaces) ? readdirSync(workspaces).sort() : [];
    // Fail the protected skill write after bot creation, using only this
    // fixture's disposable filesystem. The import must remove its new bot.
    const obstacle = join(fixture.info.dataDir, "skill-state");
    expect(existsSync(obstacle)).toBe(false);
    writeFileSync(obstacle, "fixture-only write failure", { mode: 0o600 });
    await expect(post("/api/teams/import", document)).rejects.toThrow();
    unlinkSync(obstacle);
    expect(await request("/api/bots", {}, url)).toEqual(before);
    expect(existsSync(workspaces) ? readdirSync(workspaces).sort() : []).toEqual(beforeWorkspaces);

    const imported = await post("/api/teams/import", document);
    const source = imported.bots[0];
    const skills = await request(`/api/bots/${source.id}/skills`, {}, url);
    expect(skills.skills).toHaveLength(2);
    expect(skills.skills.every((skill: { enabled: boolean }) => !skill.enabled)).toBe(true);
    await request(`/api/bots/${source.id}/skills/source-check`, {
      method: "PATCH", body: JSON.stringify({ enabled: true }),
    }, url);
    for (const skillIds of [undefined, []]) {
      const exported = await post("/api/teams/export", { format: "package", skillIds });
      expect(exported.markdown).not.toContain("SKILL_FIXTURE_MARKER");
      expect(parseBotPackage(exported.markdown).package.skills).toBeUndefined();
    }
    for (const skillIds of [["missing"], ["source-check", "source-check"], ["../private"], Array(21).fill("source-check")]) {
      await expect(post("/api/teams/export", { format: "package", skillIds })).rejects.toThrow();
    }
    const exported = await post("/api/teams/export", { format: "package", skillIds: ["source-check"] });
    expect(exported.markdown).toContain("SHARED_SKILL_FIXTURE_MARKER");
    expect(exported.markdown).not.toContain("PRIVATE_SKILL_FIXTURE_MARKER");
    const parsed = parseBotPackage(exported.markdown);
    expect(parsed.package.skills?.entries).toEqual([{
      name: "source-check", description: "Fixture instructions.", source: "package:fixture", instructions: sharedText,
    }]);
    const copied = await post("/api/teams/import", exported.markdown);
    const target = copied.bots.find((bot: { name: string }) => bot.name === "Package skill probe 2");
    expect(target).toBeDefined();
    expect((await request(`/api/bots/${target.id}/skills`, {}, url)).skills).toMatchObject([
      { name: "source-check", enabled: false },
    ]);
    await command("send", "--bot", target.id, "--text", "Confirm this isolated copy is ready.");
    expect(await command("wait", "--bot", target.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    const messages = await command("messages", "--bot", target.id, "--limit", "10");
    expect(JSON.stringify(messages)).toContain("hello from fake claude");
    expect(readFileSync(fixture.fixtureDumpPath, "utf8")).not.toContain("SKILL_FIXTURE_MARKER");
    const after = await request("/api/bots", {}, url);
    for (const bot of before.bots) expect(after.bots.find((value: { id: string }) => value.id === bot.id)).toEqual(bot);
    const backup = await post("/api/teams/export", { format: "backup" });
    expect(JSON.stringify(backup)).not.toContain("SKILL_FIXTURE_MARKER");
    console.log(JSON.stringify({ ok: true, rollback: true, explicitSelection: true, importedSkillsDisabled: true, messages, logPath: fixture.info.logPath }));
  } finally {
    await fixture.close();
  }
}, 90_000);
