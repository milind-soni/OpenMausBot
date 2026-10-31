import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { DREAM_MARKER } from "./memory-dream.ts";

it("dreams for the chosen bot, backs up its full notes and profile, then restores with confirmation", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-dream-check-"));
  const routes = join(scratch, "routes.json");
  const statement = "I want drafts under 100 words.";
  writeFileSync(routes, JSON.stringify({ [DREAM_MARKER]: JSON.stringify({ learned: [{ text: "The person wants drafts under 100 words", from: [1, 2], evidence: [statement, statement], confidence: 0.9, aboutUser: true }] }) }));
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TEXT_ROUTES: routes });
  const api = async (path: string, method = "GET", body?: unknown, status = 200) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.status, `${method} ${path}: ${status}`).toBe(status);
    return response.json() as Promise<any>;
  };
  try {
    const { bot } = await api("/api/bots", "POST", { name: "Dream fixture" }, 201);
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: false });
    for (let i = 0; i < 2; i++) {
      const { task } = await api(`/api/bots/${bot.id}/tasks`, "POST", { title: `Draft ${i}` }, 201);
      await runControlOmb(["send", "--url", fixture.info.url, "--bot", bot.id, "--task", task.threadId, "--text", statement]);
      expect(await runControlOmb(["wait", "--url", fixture.info.url, "--bot", bot.id, "--task", task.threadId, "--timeout", "30"])).toMatchObject({ status: "settled" });
    }
    await api(`/api/bots/${bot.id}/memory/file`, "PUT", { path: "MEMORY.md", text: "# Original\n" });
    await api(`/api/bots/${bot.id}/memory/file`, "PUT", { path: "memory/project.md", text: "# Project\nOriginal topic\n" });
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: true });
    const { report } = await api(`/api/bots/${bot.id}/memory/dream`, "POST");
    expect(report).toMatchObject({ conversations: 2, aboutMe: 1 });
    expect(report.learned).toHaveLength(1);
    const { backups } = await api(`/api/bots/${bot.id}/memory/dream/backups`);
    expect(backups).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "workspaces", bot.id, ".dream-backups", backups[0].id, "manifest.json"), "utf8"));
    expect(saved.files.map((file: { path: string }) => file.path)).toEqual(expect.arrayContaining(["MEMORY.md", "memory/project.md", "About me"]));
    await api(`/api/bots/${bot.id}/memory/file`, "PUT", { path: "memory/new.md", text: "after dream" });
    const conflict = await api(`/api/bots/${bot.id}/memory/dream/restore`, "POST", {}, 409);
    expect(conflict.code).toBe("changed");
    await api(`/api/bots/${bot.id}/memory/dream/restore`, "POST", { id: backups[0].id, expectedHash: conflict.currentHash });
    expect(await api(`/api/bots/${bot.id}/memory/file`)).toMatchObject({ text: "# Original\n" });
    expect(await api(`/api/bots/${bot.id}/memory/file?path=memory/new.md`)).toMatchObject({ exists: false });
    expect((await api("/api/profile/learned")).learned).toEqual([]);
    const journal = await api(`/api/bots/${bot.id}/memory/journal`);
    expect(journal.entries.some((row: { via: string }) => row.via === "dream-restore")).toBe(true);
    const result = await api(`/api/bots/${bot.id}/memory/upkeep`);
    expect(result.lastDream.learned).toHaveLength(1);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90_000);
