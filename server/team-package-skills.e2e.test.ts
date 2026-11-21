import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

it("a bot template carries its skills, which arrive disabled; originals stay; a failed install rolls back", async () => {
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
    // Fail the protected skill write after bot creation, using only this fixture's disposable filesystem.
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
    const card = await post("/api/share/export", { botId: source.id });
    expect(card).toMatchObject({ scope: "bot", status: "draft", counts: { bots: 1, skills: 2 } });
    const savedTo = mkdtempSync(join(tmpdir(), "omb-skill-template-"));
    let copied;
    try {
      const saved = await post(`/api/share/${card.id}/save`, { path: savedTo });
      expect(readFileSync(join(saved.path, "skills", "source-check", "SKILL.md"), "utf8")).toBe(sharedText);
      copied = await post("/api/share/import", { path: saved.path });
    } finally {
      rmSync(savedTo, { recursive: true, force: true });
    }
    const target = copied.bots.find((bot: { name: string }) => bot.name === "Package skill probe 2");
    expect(target).toBeDefined();
    expect((await request(`/api/bots/${target.id}/skills`, {}, url)).skills.map((skill: { name: string; enabled: boolean }) => [skill.name, skill.enabled]).sort())
      .toEqual([["private-notes", false], ["source-check", false]]);
    await command("send", "--bot", target.id, "--text", "Confirm this isolated copy is ready.");
    expect(await command("wait", "--bot", target.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    const messages = await command("messages", "--bot", target.id, "--limit", "10");
    expect(JSON.stringify(messages)).toContain("hello from fake claude");
    expect(readFileSync(fixture.fixtureDumpPath, "utf8")).not.toContain("SKILL_FIXTURE_MARKER");
    const after = await request("/api/bots", {}, url);
    // The main Chief is in charge of every department, so each imported one became its too; nothing else changed.
    expect(before.bots.filter((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff)).toHaveLength(1);
    for (const bot of before.bots) expect(after.bots.find((value: { id: string }) => value.id === bot.id))
      .toEqual(bot.chiefOfStaff ? { ...bot, managedSections: [...(bot.managedSections ?? []), imported.section] } : bot);
    const backup = await post("/api/teams/export", { format: "backup" });
    expect(JSON.stringify(backup)).not.toContain("SKILL_FIXTURE_MARKER");
    console.log(JSON.stringify({ ok: true, rollback: true, importedSkillsDisabled: true, messages, logPath: fixture.info.logPath }));
  } finally {
    await fixture.close();
  }
}, 90_000);
