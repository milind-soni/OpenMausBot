// A teammate's hand-off whose AI meets its usage limit before doing anything goes once to the bot's backup AI.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

const LIMIT = "You've hit your weekly limit · resets Oct 12 at 2:30pm (Asia/Calcutta)";
const BACKUP_REPLY = "done from fake codex";
/** The Chief settles once it has handed off; the hand-off itself (and any resend) finishes later. */
async function finishedHandoff(dataDir: string, botId: string) {
  await expect.poll(() => readHandoffs(dataDir).find((node) => node.botId === botId)?.status, { timeout: 60_000 })
    .toMatch(/^(completed|failed)$/);
  return readHandoffs(dataDir).find((node) => node.botId === botId)!;
}
const jsonLines = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

/** A Chief on one Claude sign-in hands work to a specialist on another ("helper"), with Codex as the other AI. */
async function withHandoffFixture(helperPlan: Record<string, unknown>, check: (fixture: {
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  control: (...args: string[]) => Promise<any>;
  dataDir: string; codexTurns: () => any[]; turns: () => any[]; chief: any; specialist: any; brief: string; evidence: unknown[];
}) => Promise<void>) {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true }, ["codex"]);
  const { dataDir, url, logPath } = fixture.info;
  const codexDump = join(dataDir, "codex-dump.json");
  const planPath = join(dataDir, "room-plan.json");
  const evidence: unknown[] = [{ url }];
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result: any = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.helper = { ...config.instances.claude, displayName: "Helper Claude" };
    config.instances.codex.environment = { FAKE_CODEX_DUMP: codexDump, FAKE_CODEX_DUMP_TURNS_ONLY: "1" };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => {
      const { instances } = await api("GET", "/api/instances") as { instances: any[] };
      return instances.find((instance) => instance.instanceId === "codex")?.models.options.length > 0;
    }, { timeout: 30_000 }).toBe(true);
    // The starter Chief would answer a failed run with a turn of its own; stepped down, only the turns under test run.
    const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; chiefOfStaff?: boolean }> };
    await api("PATCH", `/api/bots/${bots.find((bot) => bot.chiefOfStaff)!.id}`, { chiefOfStaff: false });
    const { bot: chief } = await control("new-bot", "--name", "Limit Chief", "--section", "Leadership");
    const { bot: specialist } = await control("new-bot", "--name", "Limit specialist", "--section", "Engineering");
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true });
    const own = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === specialist.id).modelSelection;
    await api("PATCH", `/api/bots/${specialist.id}/tasks/${specialist.activeTaskId}`, { modelSelection: { ...own, instanceId: "helper" }, updateBotDefault: true });
    const brief = "CHECK_THE_FIXTURE_REPORT_5Q";
    writeFileSync(planPath, JSON.stringify({
      [chief.id]: { turns: [
        { steps: [{ arguments: { bot_ids: [specialist.id], request_key: "limit-check", message: brief } }], reply: "Assigned the check" },
        { reply: "Chief read the specialist's answer" },
      ] },
      [specialist.id]: { turns: [{ expectContextIncludes: [brief], ...helperPlan }] },
    }));
    const codexTurns = () => {
      try { return (JSON.parse(readFileSync(codexDump, "utf8")).calls as any[]).filter((call) => call.method === "turn/start"); } catch { return []; }
    };
    await check({ api, control, dataDir, codexTurns, turns: () => jsonLines(`${planPath}.evidence.jsonl`), chief, specialist, brief, evidence });
  } finally {
    evidence.push({ nodes: readHandoffs(dataDir), turns: jsonLines(`${planPath}.evidence.jsonl`) });
    writeFileSync(`${logPath}.peer-limit-resend.json`, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

it("resends a hand-off that met the usage limit before anything ran once to the backup AI, with the same sender", async () => {
  await withHandoffFixture({ failWith: LIMIT }, async ({ api, control, dataDir, codexTurns, turns, chief, specialist, brief, evidence }) => {
    await control("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Ask Engineering to check the fixture report.");
    const child = await finishedHandoff(dataDir, specialist.id);
    evidence.push({ child });
    // Once on the limited AI, then once on the backup, which answered the hand-off.
    expect(turns().filter((turn) => turn.botId === specialist.id)).toHaveLength(1);
    expect(codexTurns()).toHaveLength(1);
    expect(JSON.stringify(codexTurns()[0])).toContain(brief);
    expect(child).toMatchObject({ status: "completed", result: BACKUP_REPLY });
    const messages = (await api("GET", `/api/threads/${child.threadId}/messages?limit=100`)).messages as any[];
    evidence.push({ messages });
    // Still the Chief's hand-off: no line became the person's own, and it was handed over once.
    expect(messages.some((message) => message.role === "user")).toBe(false);
    expect(messages.filter((message) => message.roomRequest?.id === child.id && message.roomRequest.phase === "request")).toHaveLength(1);
    expect(messages.filter((message) => message.text === BACKUP_REPLY)).toHaveLength(1);
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === specialist.id)
      .tasks.find((task: any) => task.threadId === child.threadId).busy, { timeout: 30_000 }).toBe(false);
    const after = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === specialist.id);
    expect(after.tasks.find((task: any) => task.threadId === child.threadId)).toMatchObject({ modelSelection: { instanceId: "codex" } });
    expect(after.modelSelection.instanceId).toBe("helper");
    await expect.poll(async () => ((await api("GET", `/api/threads/${chief.activeTaskId}/messages?limit=100`)).messages as any[])
      .filter((message) => message.roomRequest?.id === child.id && message.roomRequest.phase === "result").length, { timeout: 30_000 }).toBe(1);
  });
}, 180_000);

it("leaves a hand-off that already said something where it failed: nothing is sent again", async () => {
  await withHandoffFixture({ progressAfterGate: "Started reading the report", failWith: LIMIT }, async ({ api, control, dataDir, codexTurns, turns, chief, specialist }) => {
    await control("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Ask Engineering to check the fixture report.");
    const child = await finishedHandoff(dataDir, specialist.id);
    expect(turns().filter((turn) => turn.botId === specialist.id)).toHaveLength(1);
    expect(codexTurns()).toHaveLength(0);
    expect(child.status).toBe("failed");
    const after = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === specialist.id);
    expect(after.tasks.find((task: any) => task.threadId === child.threadId).modelSelection?.instanceId ?? after.modelSelection.instanceId).toBe("helper");
  });
}, 180_000);
