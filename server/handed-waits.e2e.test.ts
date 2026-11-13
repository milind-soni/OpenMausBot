import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { WAIT_MESSAGES } from "./routes/waits.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

describe("waits set by work a bot handed on", () => {
  let fixture: VerificationServer;
  let folder: string;
  let source: any;
  let peer: any;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: fixture.info.url }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const { status, body: value } = await call(method, path, body, token);
    expect(status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const file = (threadId: string, extension: string) => join(fixture.info.dataDir, `${threadId}.${extension}`);
  const finish = (threadId: string) => writeFileSync(file(threadId, "gate"), "finish isolated turn");
  const token = async (threadId: string) => {
    let value = "";
    await expect.poll(() => {
      try { value = JSON.parse(readFileSync(file(threadId, "json"), "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN; } catch { return false; }
      return Boolean(value);
    }, { timeout: 15_000 }).toBe(true);
    return value;
  };
  const rows = () => readHandoffs(fixture.info.dataDir);
  const handedWork = async (threadId: string) => {
    const find = () => rows().find((node) => node.botId === peer.id && node.parentId && rows().find((root) => root.id === node.parentId)?.threadId === threadId);
    await expect.poll(() => find()?.status, { timeout: 15_000 }).toBe("running");
    return find()!;
  };
  const handOn = async (threadId: string) => {
    const { receipts } = await api("POST", "/api/internal/coordinate-bots", { botIds: [peer.id], message: "Watch for the fixture report." }, await token(threadId));
    expect(receipts).toHaveLength(1);
    return handedWork(threadId);
  };
  const storedWaits = () => {
    try { return (JSON.parse(readFileSync(join(fixture.info.dataDir, "waits.json"), "utf8")) as { waits?: any[] }).waits ?? []; } catch { return []; }
  };
  const fileWait = (label: string) => ({ label, kind: "file_exists", path: join(folder, `${label}.txt`) });

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), "omb-handed-waits-"));
    fixture = await launchVerificationServer();
    source = (await control(["new-bot", "--name", "Wait owner"]) as any).bot;
    peer = (await control(["new-bot", "--name", "Wait peer"]) as any).bot;
    const wrapper = join(fixture.info.dataDir, "handed-gated.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const at = process.argv.indexOf("--mcp-config");',
      'const thread = at < 0 ? "probe" : JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers?.agents?.env?.OMB_THREAD_ID ?? "probe";',
      'process.env.FAKE_CLAUDE_MODE = thread === "probe" ? "happy" : "slow";',
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".gate");`,
      `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".json");`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
  }, 30_000);
  afterEach(async () => {
    await fixture?.close();
    await removeTempDir(folder);
  });

  it("lets work handed on for the person's own request set one wait, never stop one, and not after it ends", async () => {
    const sourceThread = (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === source.id).threadId;
    await control(["send", "--bot", source.id, "--text", "Have the peer tell me when the report lands."]);
    const work = await handOn(sourceThread);
    const handed = await token(work.threadId);

    const made = await call("POST", "/api/internal/waits", fileWait("report"), handed);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(storedWaits()).toEqual([expect.objectContaining({ label: "report", threadId: work.threadId, assignmentId: work.id })]);
    const second = await call("POST", "/api/internal/waits", fileWait("second"), handed);
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("keeps one wait at a time");
    const id = /\(wait id ([\w-]+)\)/.exec(made.body.text)![1];
    expect(await call("POST", "/api/internal/waits/cancel", { id }, handed)).toMatchObject({ status: 403, body: { error: WAIT_MESSAGES.handedStop } });
    expect(storedWaits()).toHaveLength(1);

    finish(work.threadId);
    await expect.poll(() => rows().find((node) => node.id === work.id)?.status, { timeout: 15_000 }).not.toBe("running");
    const late = await call("POST", "/api/internal/waits", fileWait("late"), handed);
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(storedWaits().map((wait) => wait.label)).toEqual(["report"]);
    finish(sourceThread);
  }, 60_000);

  it("refuses a wait to work a routine handed on", async () => {
    const { routine } = await api("POST", "/api/routines", {
      name: "Handed watch", prompt: "Ask the peer to watch for the report.", botId: source.id,
      enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    const { run } = await api("POST", `/api/routines/${routine.id}/run`);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((r: any) => r.id === run.id)?.status, { timeout: 15_000 }).toBe("running");
    const runThread = (await api("GET", "/api/routines")).runs.find((r: any) => r.id === run.id).threadId;
    const work = await handOn(runThread);
    expect(await call("POST", "/api/internal/waits", fileWait("routine"), await token(work.threadId))).toMatchObject({ status: 403, body: { error: WAIT_MESSAGES.notPerson } });
    expect(storedWaits()).toEqual([]);
    finish(work.threadId); finish(runThread);
  }, 60_000);
});
