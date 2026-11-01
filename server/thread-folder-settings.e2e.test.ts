import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("runs every thread of a bot with the bot's settings, and moves its threads to the working folder it is given", async () => {
  // FAKE_CLAUDE_HOOKS: the fake engine runs the Stop hooks of its --settings file, as Claude Code does.
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_HOOKS: "1" });
  const project = realpathSync(mkdtempSync(join(tmpdir(), "omb-thread-settings-project-")));
  const chosen = realpathSync(mkdtempSync(join(tmpdir(), "omb-thread-settings-chosen-")));
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const turn = async (botId: string, threadId: string, text: string) => {
    await control(["send", "--bot", botId, "--task", threadId, "--text", text]);
    expect((await control(["wait", "--bot", botId, "--task", threadId, "--timeout", "30"])).status).toBe("settled");
    return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  };
  const writeSettings = (folder: string, settings: unknown) => {
    mkdirSync(join(folder, ".claude"), { recursive: true });
    writeFileSync(join(folder, ".claude", "settings.json"), JSON.stringify(settings));
  };
  try {
    const { bot } = await api("POST", "/api/bots", { name: "Guarded helper" });
    const guardRan = join(fixture.info.dataDir, "guard-ran.txt");
    writeSettings(join(fixture.info.dataDir, "workspaces", bot.id), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: `pwd -P >> ${JSON.stringify(guardRan)}` }] }] },
      enabledPlugins: { "guard@team": true },
    });
    const ownFolder = (threadId: string) => realpathSync(join(fixture.info.dataDir, "task-workspaces", bot.id, threadId));

    const first = await turn(bot.id, bot.threadId, "Remember the fixture code MOSS-42.");
    expect(realpathSync(first.cwd)).toBe(ownFolder(bot.threadId));
    expect(first.settings.enabledPlugins).toEqual({ "guard@team": true });
    expect(readFileSync(guardRan, "utf8").trim().split("\n")).toEqual([ownFolder(bot.threadId)]);
    const { task: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling" });
    const second = await turn(bot.id, sibling.threadId, "Say hello.");
    expect(realpathSync(second.cwd)).toBe(ownFolder(sibling.threadId));
    expect(second.settings.enabledPlugins).toEqual({ "guard@team": true });
    expect(readFileSync(guardRan, "utf8").trim().split("\n")).toEqual([ownFolder(bot.threadId), ownFolder(sibling.threadId)]);

    writeFileSync(join(ownFolder(bot.threadId), "notes.txt"), "made before the move");
    writeSettings(project, { enabledPlugins: { "project@team": true } });
    await api("PATCH", `/api/bots/${bot.id}`, { cwd: project });
    const firstSession = first.argv[first.argv.indexOf("--session-id") + 1];
    const moved = await turn(bot.id, bot.threadId, "What was the fixture code?");
    expect(realpathSync(moved.cwd)).toBe(project);
    expect(moved.argv).not.toContain("--resume");
    expect(moved.argv[moved.argv.indexOf("--session-id") + 1]).not.toBe(firstSession);
    expect(JSON.stringify(moved.prompt)).toContain("MOSS-42");
    // Claude Code reads the working folder's own settings itself there.
    expect(moved.settings).not.toHaveProperty("enabledPlugins");
    expect(readFileSync(join(ownFolder(bot.threadId), "notes.txt"), "utf8")).toBe("made before the move");
    const tasks = (await api("GET", "/api/bots?messages=0")).bots.find((item: any) => item.id === bot.id).tasks;
    expect(tasks.find((task: any) => task.threadId === bot.threadId).cwd).toBe(project);
    expect(tasks.find((task: any) => task.threadId === sibling.threadId).cwd).toBe(join(fixture.info.dataDir, "task-workspaces", bot.id, sibling.threadId));

    const { task: picked } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Chosen folder", cwd: chosen });
    const kept = await turn(bot.id, picked.threadId, "Say hello from the chosen folder.");
    expect(realpathSync(kept.cwd)).toBe(chosen);
    expect(kept.settings.enabledPlugins).toEqual({ "project@team": true });

    // A room without a folder of its own runs its members in their own bot folders.
    const { group } = await api("POST", "/api/groups", { name: "Guarded room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    await control(["send-channel", "--channel", group.id, "--text", "Say hello to the room."]);
    expect((await control(["wait", "--channel", group.id, "--timeout", "30"])).status).toBe("settled");
    const room = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(realpathSync(room.cwd)).toBe(realpathSync(join(fixture.info.dataDir, "workspaces", bot.id)));
    expect(room.settings.enabledPlugins).toEqual({ "project@team": true });
  } finally {
    await fixture.close();
    await removeTempDir(project);
    await removeTempDir(chosen);
  }
}, 90_000);
