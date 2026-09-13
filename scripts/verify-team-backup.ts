// One owned fake-engine fixture. This command accepts no live server URL.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { request } from "./mcp-server.ts";
import { parseTeamBackup } from "../shared/team-backup.ts";

export async function verifyTeamBackup(report: (event: unknown) => void = () => {}) {
  const fixture = await launchVerificationServer();
  report({ fixture: fixture.info });
  const url = fixture.info.url;
  const command = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]);
    report({ command: [...args, "--url", url], result });
    return result;
  };
  const post = (path: string, body: unknown) => request(path, { method: "POST", body: JSON.stringify(body) }, url);
  try {
    const doctor = await command("doctor") as { ok: boolean };
    assert.equal(doctor.ok, true);
    const { bot } = await command("new-bot", "--name", "Backup probe", "--section", "Original team") as { bot: { id: string } };
    await request(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ chiefOfStaff: true }) }, url);
    await post("/api/groups", { name: "Existing room", memberIds: [bot.id], section: "Original team" });
    const soul = "Keep the fixture's standing instructions. 🐭\n";
    await request(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ soul }) }, url);
    report({ command: "save standing instructions", botId: bot.id, soul });
    await command("send", "--bot", bot.id, "--text", "Remember the backup verification conversation. Reply once.");
    const wait = await command("wait", "--bot", bot.id, "--timeout", "30") as { status: string };
    assert.equal(wait.status, "settled");
    const transcript = await command("messages", "--bot", bot.id, "--limit", "10");
    const before = await request("/api/bots", {}, url);
    const backup = parseTeamBackup(await post("/api/teams/export", { format: "backup", name: "Fixture backup" }));
    report({ command: "export backup", bots: backup.bots.length, conversations: backup.bots.reduce((n, bot) => n + bot.tasks.length, 0) });
    const imported = await post("/api/teams/import?mode=add", JSON.parse(JSON.stringify(backup)));
    assert.equal(imported.bots.length, before.bots.length);
    const added = imported.bots.find((candidate: { name: string }) => candidate.name === "Backup probe 2");
    assert.ok(added);
    assert.equal(added.section, "Original team 2");
    assert.equal(added.soul, soul);
    const after = await request("/api/bots", {}, url);
    for (const existing of before.bots) assert.deepEqual(after.bots.find((candidate: { id: string }) => candidate.id === existing.id), existing);
    for (const existing of before.groups) assert.deepEqual(after.groups.find((candidate: { id: string }) => candidate.id === existing.id), existing);
    assert.deepEqual(await command("messages", "--bot", bot.id, "--limit", "10"), transcript);
    const old = before.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    assert.ok(old.messages.some((message: { role: string; kind: string; text?: string }) => message.role === "bot" && message.kind === "text" && message.text?.includes("hello from fake claude")));
    for (const message of old.messages.filter((message: { kind: string }) => message.kind === "text")) {
      assert.ok(added.messages.some((copy: { text: string; id: string }) => copy.text === message.text && copy.id !== message.id));
    }
    await command("messages", "--bot", added.id, "--limit", "10");
    await assert.rejects(post("/api/teams/import?mode=replace", backup), /Replacing your team/);
    await assert.rejects(post("/api/teams/import", { ...backup, version: 999 }), /Invalid backup/);
    assert.deepEqual(await request("/api/bots", {}, url), after);
    // Setup-only files must preserve the same persona, without importing
    // conversations or permissions. Exercise the real manifest import too.
    const manifest = await post("/api/teams/export", { name: "Fixture manifest" });
    assert.equal(manifest.team.members.find((member: { name: string }) => member.name === "Backup probe").soul, soul);
    const fromManifest = await post("/api/teams/import?mode=add", manifest);
    assert.equal(fromManifest.bots.find((candidate: { name: string }) => candidate.name === "Backup probe 3").soul, soul);
    assert.ok(fromManifest.bots.every((candidate: { section?: string }) => candidate.section === "Fixture manifest"));
    const packageExport = await post("/api/teams/export", { format: "package", name: "Fixture manifest" });
    // Older library files, repeated imports, project rooms and Markdown all
    // use the same additive path. Compare EVERY existing record each time,
    // including previous imports, section Chiefs and room membership.
    for (const [index, example] of [
      { format: "legacy v1", path: "/api/teams/import?mode=add", body: { ...manifest, version: 1, team: { ...manifest.team, room: { name: "Ignored legacy room", defaultResponder: { kind: "everyone" } } } } },
      { format: "legacy v2 project", path: "/api/teams/import?mode=project&room=Template%20room", body: manifest },
      { format: "Markdown package", path: "/api/teams/import?mode=add", body: packageExport.markdown },
      { format: "repeated Markdown package", path: "/api/teams/import?mode=add", body: packageExport.markdown },
    ].entries()) {
      const existing = await request("/api/bots", {}, url);
      const result = await post(example.path, example.body);
      const section = `Fixture manifest ${index + 2}`;
      assert.ok(result.bots.length > 0);
      assert.ok(result.bots.every((candidate: { section?: string; messages: unknown[] }) => candidate.section === section && candidate.messages.length === 0));
      assert.ok(result.groups.every((candidate: { section?: string }) => candidate.section === section));
      if (example.format.includes("project")) assert.equal(result.group.section, section);
      const current = await request("/api/bots", {}, url);
      assert.equal(current.bots.length, existing.bots.length + result.bots.length);
      assert.equal(current.groups.length, existing.groups.length + result.groups.length);
      for (const value of existing.bots) assert.deepEqual(current.bots.find((candidate: { id: string }) => candidate.id === value.id), value);
      for (const value of existing.groups) assert.deepEqual(current.groups.find((candidate: { id: string }) => candidate.id === value.id), value);
      assert.deepEqual(await command("messages", "--bot", bot.id, "--limit", "10"), transcript);
      report({ command: "import template", format: example.format, section, existingBotsKept: existing.bots.length, existingRoomsKept: existing.groups.length });
    }
    await command("send", "--bot", fromManifest.bots[0].id, "--text", "Confirm the imported template is ready. Reply once.");
    assert.equal((await command("wait", "--bot", fromManifest.bots[0].id, "--timeout", "30") as { status: string }).status, "settled");
    assert.ok(JSON.stringify(await command("messages", "--bot", fromManifest.bots[0].id, "--limit", "10")).includes("hello from fake claude"));
    // The copied history is usable for a fresh turn without resuming the
    // original provider session or altering the original bot's transcript.
    await command("send", "--bot", added.id, "--text", "Continue the imported conversation. Reply once.");
    const resumed = await command("wait", "--bot", added.id, "--timeout", "30") as { status: string };
    assert.equal(resumed.status, "settled");
    await command("messages", "--bot", added.id, "--limit", "10");
    assert.deepEqual(await command("messages", "--bot", bot.id, "--limit", "10"), transcript);
    const result = { ok: true, existingBotsKept: before.bots.length, importedBots: imported.bots.length, originalConversationUnchanged: true, importedConversationContinued: true, standingInstructionsPreserved: true, templateSectionsIsolated: true, logPath: fixture.info.logPath };
    report(result);
    return result;
  } finally {
    await fixture.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyTeamBackup((event) => console.log(JSON.stringify(event))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
