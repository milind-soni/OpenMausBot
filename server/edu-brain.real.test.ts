// Runs only where Edu 6+ is installed (CI has none). Every brain is in a temporary folder.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createEduBrains, eduRegistryHome, locateEduCli, type EduStdioServer } from "./edu-brain.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const cli = locateEduCli({ PATH: process.env.PATH }, process.env.PATH ?? "");
const root = mkdtempSync(join(tmpdir(), "edu-real-"));
afterAll(() => removeTempDir(root));

type Reply = { result?: { isError?: boolean; content?: Array<{ text?: string }>; tools?: Array<{ name: string }> }; error?: { message: string } };

async function session(server: EduStdioServer, extraEnv: Record<string, string>) {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env, ...extraEnv }, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map<number, (reply: Reply) => void>();
  let buffer = "", id = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try { const message = JSON.parse(line) as Reply & { id?: number }; if (message.id !== undefined) waiting.get(message.id)?.(message); } catch {}
    }
  });
  const request = (method: string, params: object) => new Promise<Reply>((done) => {
    waiting.set(++id, done);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "edu-bot-test", version: "0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const call = async (name: string, args: object) => {
    const reply = await request("tools/call", { name, arguments: args });
    return { ok: !reply.error && !reply.result?.isError, text: reply.result?.content?.[0]?.text ?? reply.error?.message ?? "" };
  };
  return { request, call, close: () => child.kill() };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);
}

describe.skipIf(!cli)("the installed Edu binary", () => {
  const dataDir = join(root, "data"), eduHome = join(root, "global"), home = join(root, "home");
  const env = { ...process.env, HOME: home, USERPROFILE: home, OMB_EDU_CLI: cli! };
  const brains = createEduBrains({ dataDir, config: () => ({ home: eduHome }), env });
  const bot = { id: "bot-real", name: "Luna" };
  const projects = (edu: string) => existsSync(join(edu, "projects.json")) ? readFileSync(join(edu, "projects.json"), "utf8") : "";

  it("registers a bot's own brain in Edu Bot's private registry, never in the global brain's projects.json", async () => {
    mkdirSync(home, { recursive: true });
    execFileSync(process.execPath, [cli!, "init", "--global", "--name", "Global"], { env: { ...env, EDU_HOME: eduHome } });
    const seeded = { name: "home-project", root: join(home, "project"), brain: join(home, "project", ".edu", "brain"), addedAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(join(eduHome, "projects.json"), `${JSON.stringify({ projects: [seeded] }, null, 2)}\n`);
    const before = projects(eduHome);
    expect(await brains.integration(bot, { local: true })).not.toBeNull();
    expect(projects(eduHome)).toBe(before);
    expect(projects(eduHome)).not.toContain(bot.id);
    expect(projects(eduRegistryHome(dataDir))).toContain(join(dataDir, "brains", bot.id));
  });

  it("serves a bot its own brain: notes land there, the brain cannot be switched, crew tools are absent", async () => {
    expect((await brains.detect()).state).toBe("ready");
    const server = await brains.integration(bot, { local: true });
    expect(server).not.toBeNull();
    expect(server!.env.EDU_HOME).toBe(eduHome);
    const edu = await session(server!, { EDU_CREW_JOB: "", HOME: home });
    try {
      const names = ((await edu.request("tools/list", {})).result?.tools ?? []).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["edu_recall", "edu_remember", "edu_propose_canonical"]));
      expect(names.filter((name) => name.startsWith("edu_crew") || name === "edu_orchestrate")).toEqual([]);

      const remembered = await edu.call("edu_remember", { tier: "transitive", kind: "decision", band: "inferred", title: "Real binary note", body: "Stored by the Edu Bot test." });
      expect(remembered, remembered.text).toMatchObject({ ok: true });
      const brain = join(dataDir, "brains", bot.id, ".edu", "brain");
      const note = filesUnder(brain).find((file) => file.endsWith("real-binary-note.md"));
      expect(note).toBeDefined();
      expect(readFileSync(note!, "utf8")).toContain("Stored by the Edu Bot test.");
      expect((await edu.call("edu_recall", { query: "real binary note" })).text).toContain("Real binary note");

      const outside = await session({ ...server!, args: [cli!, "--cwd", home, "mcp", "--profile", "memory"] }, { HOME: home });
      try {
        expect(await outside.call("edu_remember", { tier: "transitive", kind: "decision", band: "inferred", title: "Global overlay note", body: "x" })).toMatchObject({ ok: true });
      } finally {
        outside.close();
      }
      expect((await edu.call("edu_recall", { query: "global overlay note" })).text).toContain("Global overlay note");

      const switched = await edu.call("edu_project_use", { workspace: "global" });
      expect(switched.ok).toBe(false);
      const proposed = await edu.call("edu_propose_canonical", { kind: "preference", title: "Real binary preference", body: "x" });
      expect(proposed.text).toContain("proposed");
    } finally {
      edu.close();
    }
  });

  it("refuses brain writes from a process that carries the crew-worker guard", async () => {
    const edu = await session((await brains.integration(bot, { local: true }))!, { EDU_CREW_JOB: `edu-bot:${bot.id}`, HOME: home });
    try {
      expect(await edu.call("edu_remember", { tier: "episodic", title: "Should not land", body: "x" })).toMatchObject({ ok: false });
      expect((await edu.call("edu_recall", { query: "real binary note" })).ok).toBe(true);
    } finally {
      edu.close();
    }
  });

  it("does not mount a brain whose .edu was swapped for a link to another brain, which Edu would write through", async () => {
    const linked = { id: "bot-linked", name: "Sol" };
    const victim = join(root, "victim");
    mkdirSync(victim);
    execFileSync(process.execPath, [cli!, "--cwd", victim, "init", "--name", "Victim"], { env: { ...env, EDU_HOME: eduRegistryHome(dataDir) } });
    const own = (await brains.integration(linked, { local: true }))!;
    const folder = join(dataDir, "brains", linked.id);
    renameSync(join(folder, ".edu"), join(root, "parked"));
    symlinkSync(join(victim, ".edu"), join(folder, ".edu"));

    expect(await brains.integration(linked, { local: true })).toBeNull();
    expect(await brains.status(linked)).toMatchObject({ state: "broken", reason: expect.stringMatching(/link/) });

    const unguarded = await session(own, { EDU_CREW_JOB: "", HOME: home });
    try {
      expect(await unguarded.call("edu_remember", { tier: "transitive", kind: "decision", band: "inferred", title: "Written through the link", body: "x" })).toMatchObject({ ok: true });
    } finally {
      unguarded.close();
    }
    expect(filesUnder(join(victim, ".edu", "brain")).some((file) => file.endsWith("written-through-the-link.md"))).toBe(true);
  });

  it("does not mount a brain whose .edu/brain was swapped for a link to another brain", async () => {
    const linked = { id: "bot-nested", name: "Rio" };
    const victim = join(root, "victim-nested");
    mkdirSync(victim);
    execFileSync(process.execPath, [cli!, "--cwd", victim, "init", "--name", "Victim"], { env: { ...env, EDU_HOME: eduRegistryHome(dataDir) } });
    expect(await brains.integration(linked, { local: true })).not.toBeNull();
    const folder = join(dataDir, "brains", linked.id);
    renameSync(join(folder, ".edu", "brain"), join(root, "parked-nested"));
    symlinkSync(join(victim, ".edu", "brain"), join(folder, ".edu", "brain"));

    expect(await brains.integration(linked, { local: true })).toBeNull();
    expect(await brains.status(linked)).toMatchObject({ state: "broken", reason: expect.stringMatching(/\.edu\/brain is a link/) });
  });
});
