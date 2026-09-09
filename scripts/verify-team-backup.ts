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
    // The copied history is usable for a fresh turn without resuming the
    // original provider session or altering the original bot's transcript.
    await command("send", "--bot", added.id, "--text", "Continue the imported conversation. Reply once.");
    const resumed = await command("wait", "--bot", added.id, "--timeout", "30") as { status: string };
    assert.equal(resumed.status, "settled");
    await command("messages", "--bot", added.id, "--limit", "10");
    assert.deepEqual(await command("messages", "--bot", bot.id, "--limit", "10"), transcript);
    const result = { ok: true, existingBotsKept: before.bots.length, importedBots: imported.bots.length, originalConversationUnchanged: true, importedConversationContinued: true, standingInstructionsPreserved: true, logPath: fixture.info.logPath };
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
