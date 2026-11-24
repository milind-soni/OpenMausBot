import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { rebuiltSessionNotice } from "../resume-recovery.ts";
import { engineSessionFolders } from "./delete-leftovers.ts";
import { createLoggedSessions, liveSessions, sweepEngineSessions } from "./engine-session-sweep.ts";

const ENDED = "00000000-0000-4000-8000-00000000e7d0";

// Cloud homes, where this runs, are Linux.
it.skipIf(process.platform === "win32")("a conversation whose ended engine sessions were pruned still resumes the session it is on", async () => {
  // The fake CLI keeps projects/<folder>/<session>.jsonl as Claude Code does and refuses --resume without it; each turn's
  // engine exits once it answers, so the next turn relaunches with --resume.
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_HOME_FILES: "1", FAKE_CLAUDE_EXIT_AFTER_TURN: "1" });
  try {
    const dataDir = fixture.info.dataDir;
    const claude = join(dataDir, ".claude");
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token-not-a-credential" } }));
    const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(response.ok).toBe(true);
      return response.json() as Promise<any>;
    };
    const { bot } = await api("POST", "/api/bots", { name: "Session keeper" });
    const turn = async (text: string) => {
      await control(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text]);
      expect((await control(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30"])).status).toBe("settled");
    };
    await turn("First: remember the word HERON.");
    const bots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as any[];
    const cursor = Object.values(bots.find((b) => b.id === bot.id)?.resumeCursors ?? {})[0] as string;
    const project = readdirSync(join(claude, "projects")).find((folder) => existsSync(join(claude, "projects", folder, `${cursor}.jsonl`)))!;
    expect(project).toBeTruthy();

    // An earlier session of this conversation that it moved off, as a compaction or a model change leaves one.
    const old = new Date(Date.now() - 10 * 24 * 60 * 60_000);
    const ended = [join(claude, "projects", project, `${ENDED}.jsonl`), join(claude, "file-history", ENDED, "a@v1")];
    for (const file of ended) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "{}\n");
      utimesSync(file, old, old);
    }
    utimesSync(join(claude, "file-history", ENDED), old, old);
    appendFileSync(join(dataDir, "events", `${bot.threadId}.ndjson`), `${JSON.stringify({ eventId: "e", provider: "claudeAgent", threadId: bot.threadId, createdAt: old.toISOString(), type: "session.started", sessionId: ENDED, model: "m" })}\n`);
    // The live session is as old: age alone never removes it.
    utimesSync(join(claude, "projects", project, `${cursor}.jsonl`), old, old);

    const result = await sweepEngineSessions({
      dataDir, mode: "on", folders: engineSessionFolders(dataDir, [{ HOME: dataDir }]), cacheRoots: [],
      live: () => liveSessions(JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"))), logged: await createLoggedSessions(join(dataDir, "events"))(),
    });
    expect(result.refused).toBeUndefined();
    expect(result.sessions).toBe(1);
    for (const file of ended) expect(existsSync(file)).toBe(false);
    expect(existsSync(join(claude, "projects", project, `${cursor}.jsonl`))).toBe(true);
    expect(existsSync(join(claude, ".credentials.json"))).toBe(true);

    await turn("Second: what was the word?");
    const argv = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).argv as string[];
    expect(argv.indexOf("--resume")).toBeGreaterThan(-1);
    expect(argv[argv.indexOf("--resume") + 1]).toBe(cursor);
    const said = JSON.stringify((await api("GET", "/api/bots")).bots.find((b: any) => b.id === bot.id).messages);
    expect(said).toContain("remember the word HERON");
    expect(said).not.toContain("No conversation found");
  } finally {
    await fixture.close();
  }
}, 120_000);

it.skipIf(process.platform === "win32")("a conversation whose session Claude Code's own 30-day sweep removed goes on from its chat, and says so", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_HOME_FILES: "1", FAKE_CLAUDE_EXIT_AFTER_TURN: "1" });
  try {
    const dataDir = fixture.info.dataDir;
    const claude = join(dataDir, ".claude");
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token-not-a-credential" } }));
    const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
    const bots = async () => (await (await fetch(`${fixture.info.url}/api/bots`)).json() as any).bots as any[];
    const created = await (await fetch(`${fixture.info.url}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Old friend" }) })).json() as any;
    const bot = created.bot;
    const turn = async (text: string) => {
      await control(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text]);
      expect((await control(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30"])).status).toBe("settled");
    };
    await turn("First: remember the word HERON.");
    const saved = (JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as any[]).find((b) => b.id === bot.id);
    const cursor = Object.values(saved?.resumeCursors ?? {})[0] as string;
    const project = readdirSync(join(claude, "projects")).find((folder) => existsSync(join(claude, "projects", folder, `${cursor}.jsonl`)))!;
    // What Claude Code's cleanupPeriodDays sweep does to a session idle past it.
    rmSync(join(claude, "projects", project, `${cursor}.jsonl`));

    await turn("Back after a long while: what was the word?");
    const messages = (await bots()).find((b) => b.id === bot.id).messages as any[];
    const after = messages.slice(messages.findIndex((m) => m.role === "user" && m.text?.includes("Back after a long while")));
    expect(after.some((m) => m.kind === "activity" && m.tool?.name === `notice: ${rebuiltSessionNotice("Claude Code")}`)).toBe(true);
    expect(after.some((m) => m.role === "bot" && m.kind === "text" && m.text)).toBe(true);
    expect(JSON.stringify(messages)).toContain("remember the word HERON");
  } finally {
    await fixture.close();
  }
}, 120_000);
