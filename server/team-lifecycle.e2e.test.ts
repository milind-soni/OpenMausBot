import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("retains empty teams, moves existing bots, and keeps legacy imports additive through restart", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  const evidence: unknown[] = [{ fixture: fixture.info }];
  let restarted: ChildProcess | undefined;
  const api = async (path: string, method = "GET", body?: unknown, status = 200) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as Record<string, any>;
    evidence.push({ path, method, body, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(status);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]);
    evidence.push({ command: args, result });
    return result;
  };
  try {
    const a = (await control("new-bot", "--name", "Fixture researcher", "--section", "Research") as any).bot;
    const b = (await control("new-bot", "--name", "Fixture engineer", "--section", "Engineering") as any).bot;
    const messages = async () => (await control("messages", "--bot", a.id, "--limit", "10") as { messages: unknown[] }).messages;
    await control("send", "--bot", a.id, "--text", "Remember the original fixture conversation.");
    expect(await control("wait", "--bot", a.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    const transcript = await messages();
    await api("/api/sidebar-sections", "POST", { name: "Delivery" });
    await api("/api/sidebar-sections", "POST", { name: "Untouched empty", botIds: [] });
    expect((await api("/api/bots?messages=0")).sections).toEqual(expect.arrayContaining(["Research", "Engineering", "Delivery", "Untouched empty"]));
    await api("/api/section-context?section=Delivery", "PUT", { text: "Finish research before engineering." });
    const moved = await api("/api/sidebar-sections", "POST", { name: "Delivery", botIds: [a.id, b.id] });
    expect(moved.bots.map((bot: any) => bot.id)).toEqual([a.id, b.id]);
    expect(moved.bots.every((bot: any) => bot.section === "Delivery")).toBe(true);
    expect(await messages()).toEqual(transcript);
    await api("/api/sidebar-sections?section=Delivery", "PATCH", { name: "Renamed" }, 409);
    await api("/api/sidebar-sections?section=Delivery", "DELETE", undefined, 409);
    await api("/api/sidebar-sections", "POST", { name: "", botIds: [a.id, b.id] });
    expect((await api("/api/sidebar-sections")).sections).toContain("Delivery");
    await api("/api/sidebar-sections?section=Delivery", "PATCH", { name: "Launch" });
    expect((await api("/api/section-context?section=Launch")).text).toBe("Finish research before engineering.");
    await api("/api/sidebar-sections?section=Launch", "PATCH", { name: "Untouched empty" }, 409);

    // Legacy templates cannot occupy an existing empty team's name or brief.
    const imported = await api("/api/teams/import?mode=add", "POST", {
      format: "openmaus.team", version: 2, team: { name: "Launch", members: [
        { key: "writer", name: "Fixture writer", appearance: { color: "purple" } },
      ] },
    }, 201);
    expect(imported.bots[0].section).toBe("Launch 2");
    expect(imported.bots[0].id).not.toBe(a.id);
    expect((await api("/api/section-context?section=Launch")).text).toBe("Finish research before engineering.");
    expect(await messages()).toEqual(transcript);

    // Archived membership still prevents deleting an occupied team.
    await api(`/api/bots/${imported.bots[0].id}`, "PATCH", { hidden: true });
    await api("/api/sidebar-sections?section=Launch%202", "DELETE", undefined, 409);
    await api(`/api/bots/${imported.bots[0].id}`, "DELETE");
    expect((await api("/api/sidebar-sections")).sections).toContain("Launch 2");
    await api("/api/sidebar-sections?section=Launch%202", "DELETE");
    await api("/api/sidebar-sections?section=missing", "DELETE", undefined, 404);

    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      HOME: dataDir, USERPROFILE: dataDir, OMB_DATA_DIR: dataDir,
      APPDATA: join(dataDir, "AppData", "Roaming"), LOCALAPPDATA: join(dataDir, "AppData", "Local"),
      XDG_CONFIG_HOME: join(dataDir, ".config"), XDG_CACHE_HOME: join(dataDir, ".cache"),
      XDG_DATA_HOME: join(dataDir, ".local", "share"), HERMES_HOME: join(dataDir, ".hermes"),
      TEMP: join(dataDir, "tmp"), TMP: join(dataDir, "tmp"), TMPDIR: join(dataDir, "tmp"),
      OMB_PORT: new URL(url).port, OMB_WEBHOOK_PORT: String(Number(new URL(url).port) + 1),
      PATH: dirname(process.execPath), FAKE_CLAUDE_MODE: "happy",
    });
    const restartFixture = async () => {
      const log = openSync(logPath, "a", 0o600);
      restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
      });
      closeSync(log);
      await expect.poll(async () => {
        if (restarted?.exitCode !== null) throw new Error(readFileSync(logPath, "utf8"));
        return fetch(url + "/api/health").then(response => response.ok).catch(() => false);
      }, { timeout: 15_000, interval: 150 }).toBe(true);
    };
    await restartFixture();
    const state = await api("/api/bots?messages=0");
    expect(state.sections).toEqual(expect.arrayContaining(["Research", "Engineering", "Launch", "Untouched empty"]));
    expect(state.sections).not.toContain("Delivery");
    expect(state.sections).not.toContain("Launch 2");
    expect(state.bots.find((bot: any) => bot.id === a.id).section).toBeUndefined();
    expect((await api("/api/section-context?section=Launch")).text).toBe("Finish research before engineering.");
    expect(await messages()).toEqual(transcript);
    await api("/api/sidebar-sections?section=Launch", "DELETE");
    await api("/api/section-context?section=Launch", "GET", undefined, 404);
    expect(readFileSync(logPath, "utf8")).not.toMatch(/ReferenceError|store: change listener threw/);

    // The team file is independent of bot/group transcripts. A malformed
    // registry must not abort startup, including legacy migration saves.
    const room = (await control("new-channel", "--name", "Recovery room", "--members", a.id) as any).channel;
    await control("send-channel", "--channel", room.id, "--text", "Keep this group conversation through recovery.");
    expect(await control("wait", "--channel", room.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    const roomMessages = (await control("messages", "--channel", room.id, "--limit", "10") as any).messages;
    await waitForExit(restarted, { signal: "SIGTERM" });
    const legacyBots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    const legacyGroups = JSON.parse(readFileSync(join(dataDir, "groups.json"), "utf8"));
    const legacyBot = legacyBots.find((bot: any) => bot.id === a.id);
    const legacyGroup = legacyGroups.find((group: any) => group.id === room.id);
    delete legacyBot.tasks; delete legacyBot.soulHash; legacyBot.section = "Recovered bot team";
    delete legacyGroup.tasks; delete legacyGroup.defaultResponder; legacyGroup.section = "Recovered group team";
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify(legacyBots));
    writeFileSync(join(dataDir, "groups.json"), JSON.stringify(legacyGroups));
    const malformed = '{"version":1,"contexts":';
    const registryFile = join(dataDir, "section-contexts.json");
    writeFileSync(registryFile, malformed);
    await restartFixture();
    const recovered = await api("/api/bots?messages=0");
    expect(recovered.bots.find((bot: any) => bot.id === a.id)).toMatchObject({ section: "Recovered bot team", tasks: [{ threadId: a.activeTaskId }] });
    expect(recovered.groups.find((group: any) => group.id === room.id)).toMatchObject({ section: "Recovered group team", defaultResponder: { kind: "member", botId: a.id } });
    expect(await messages()).toEqual(transcript);
    expect((await control("messages", "--channel", room.id, "--limit", "10") as any).messages).toEqual(roomMessages);
    expect(JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")).find((bot: any) => bot.id === a.id).tasks).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dataDir, "groups.json"), "utf8")).find((group: any) => group.id === room.id).tasks).toHaveLength(1);
    await api("/api/sidebar-sections", "POST", { name: "Must not overwrite recovery data" }, 500);
    await api("/api/section-context?section=Recovered%20bot%20team", "PUT", { text: "Must not replace the damaged file" }, 500);
    expect(readFileSync(registryFile, "utf8")).toBe(malformed);
    expect(readFileSync(logPath, "utf8")).toContain("[teams] Startup could not register team names");
    evidence.push({ malformedRegistryRestart: true, legacyBotAndGroupMigrated: true, conversationsRetained: true, laterTeamWritesRejected: true });
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    const evidencePath = `${logPath}.team-lifecycle.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    expect(existsSync(dataDir)).toBe(false);
    console.info(JSON.stringify({ ...fixture.info, evidencePath, fixtureRemoved: true }));
  }
}, 60_000);
