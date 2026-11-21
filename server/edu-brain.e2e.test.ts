// A real server and the real installed Edu (skipped where none is installed, as on CI): the fake engine's turn calls
// edu_remember and edu_recall through the `edu` server the harness mounted, and the note lands in the bot's own brain in
// the fixture's data folder. The global Edu brain is a temporary folder too.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { locateEduCli } from "./edu-brain.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const cli = locateEduCli({ PATH: process.env.PATH }, process.env.PATH ?? "");

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);
  } catch {
    return [];
  }
}

const client = (fixture: VerificationServer) => async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};

it.skipIf(!cli)("gives a bot its own Edu brain: a remembered note lands there and recall finds it", async () => {
  const eduHome = mkdtempSync(join(tmpdir(), "edu-fixture-home-"));
  const fixture = await launchVerificationServer({
    EDU_FIXTURE_HOME: eduHome,
    OMB_EDU_CLI: cli!,
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([
      { server: "edu", name: "edu_remember", input: { tier: "transitive", kind: "decision", band: "inferred", title: "Fixture decision", body: "Reports go out on Mondays." } },
      { server: "edu", name: "edu_recall", input: { query: "fixture decision" } },
      { server: "edu", name: "edu_project_use", input: { workspace: "global" } },
    ]),
  });
  const api = client(fixture);
  try {
    const bot = (await api("POST", "/api/bots", { name: "Luna" })).body.bot;
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Remember that reports go out on Mondays", "--url", fixture.info.url]);
    await runControlOmb(["wait", "--bot", bot.id, "--timeout", "90", "--url", fixture.info.url]);

    const brain = join(fixture.info.dataDir, "brains", bot.id);
    const note = filesUnder(join(brain, ".edu", "brain")).find((file) => file.endsWith("fixture-decision.md"));
    expect(note, `no note under ${brain}`).toBeDefined();
    expect(readFileSync(note!, "utf8")).toContain("Reports go out on Mondays.");
    expect(filesUnder(join(eduHome, "brain")).filter((file) => file.endsWith("fixture-decision.md"))).toEqual([]);

    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(dump.mcpConfig.mcpServers.edu.args.slice(-5)).toEqual(["--cwd", brain, "mcp", "--profile", "memory"]);
    expect(dump.mcpConfig.mcpServers.edu.env).toMatchObject({ EDU_LOCK_WORKSPACE: "1", EDU_HOME: eduHome, EDU_CREW_JOB: "" });
    expect(dump.env.EDU_CREW_JOB).toBe(`edu-bot:${bot.id}`);

    const transcript = JSON.stringify((await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages);
    expect(transcript).toContain("Fixture decision");
    expect(transcript).toContain("The host owns this workspace");

    const memory = await api("GET", `/api/bots/${bot.id}/memory`);
    expect(memory.body.edu).toMatchObject({ state: "ready", mode: "own", brain, home: eduHome });

    const globalProjects = join(eduHome, "projects.json");
    expect(existsSync(globalProjects) ? readFileSync(globalProjects, "utf8") : "").not.toContain(bot.id);
    expect(readFileSync(join(fixture.info.dataDir, "edu-registry", "projects.json"), "utf8")).toContain(brain);

    const elsewhere = join(eduHome, "..", `${bot.id}-area`);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { eduBrain: { mode: "folder", path: elsewhere } })).status).toBe(403);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { eduBrain: { mode: "folder", path: eduHome } })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { eduBrain: { mode: "off" } })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { eduBrain: { mode: "own" } })).status).toBe(403);
  } finally {
    await fixture.close();
    await removeTempDir(eduHome);
  }
}, 180_000);

it("mounts no Edu and still answers when Edu is not installed", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_TOOL_CALLS: "[]" });
  const api = client(fixture);
  try {
    const bot = (await api("POST", "/api/bots", { name: "Luna" })).body.bot;
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Hello", "--url", fixture.info.url]);
    await runControlOmb(["wait", "--bot", bot.id, "--timeout", "60", "--url", fixture.info.url]);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(dump.mcpConfig.mcpServers.edu).toBeUndefined();
    expect(dump.env.EDU_CREW_JOB).toBeUndefined();
    expect((await api("GET", `/api/bots/${bot.id}/memory`)).body.edu).toMatchObject({ state: "missing", mode: "own" });
    const rows = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages as any[];
    expect(rows.some((row) => row.role === "bot" && String(row.text ?? "").length > 0)).toBe(true);
    expect(rows.filter((row) => row.kind === "error" || /edu/i.test(String(row.text ?? "")))).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 120_000);
