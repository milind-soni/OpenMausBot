// A 2 GB Starter-sized machine that fits one turn at a time, on the fake engine: whose turn goes next, and what a stop does.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

const GB = 1024 ** 3, MB = 1024 ** 2;

async function fixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer({ ...process.env, OMB_TEST_MEMORY_GATE: "1" }, undefined, undefined, undefined, undefined, { scripted: true });
  const { dataDir } = session.info;
  const free = (bytes: number) => writeFileSync(join(dataDir, "host-memory.json"), JSON.stringify({ totalBytes: 2 * GB, availableBytes: bytes, swapFreeBytes: 0, oomKills: 0, fullStall10: 0 }));
  free(900 * MB);
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const planPath = join(dataDir, "room-plan.json");
  /** The bots whose turns have ended, in the order they did. With room for one at a time that is the order they ran in. */
  const ended = (): string[] => existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).botId) : [];
  const bot = async (name: string) => (await cli("new-bot", "--name", name, "--section", "Team")).bot;
  const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages as any[];
  try { await test({ session, dataDir, cli, api, planPath, ended, bot, messages, free }); }
  finally { await session.close(); }
}

it("starts the person's own line ahead of a hand-off that was already waiting for memory, and the hand-off right after", () => fixture(async (f) => {
  const [chief, first, second, person] = [await f.bot("Clive"), await f.bot("First"), await f.bot("Second"), await f.bot("Person's bot")];
  await f.api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Team"], acknowledgePeerScope: true }, "PATCH");
  const gate = join(f.dataDir, "first-may-finish"), firstRunning = join(f.dataDir, "first-is-running");
  writeFileSync(f.planPath, JSON.stringify({
    [chief.id]: { steps: [{ arguments: { bot_ids: [first.id], message: "First job" } }, { arguments: { bot_ids: [second.id], message: "Second job" } }], reply: "Sent", resumeReply: "Done" },
    [first.id]: { readyFile: firstRunning, gateFile: gate, reply: "First done" },
    [second.id]: { reply: "Second done" },
    [person.id]: { reply: "Yours" },
  }));
  await f.cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Please hand out the two jobs.");
  const nodes = () => readHandoffs(f.dataDir).filter((node: any) => node.parentId);
  await expect.poll(() => nodes().length, { timeout: 30_000 }).toBe(2);
  const held = nodes().find((node: any) => node.botId === second.id)!;
  await expect.poll(async () => (await f.messages(held.threadId)).some((message: any) => message.tool?.name?.includes("Waiting for memory")), { timeout: 30_000 }).toBe(true);
  // Memory, not the plan's thread limit or anything before the gate: the hand-off itself has started, and its record says why it waits.
  expect(nodes().find((node: any) => node.id === held.id)!.status).toBe("running");
  const db = new DatabaseSync(join(f.dataDir, "runtime.db"), { readOnly: true });
  try {
    expect((db.prepare("SELECT kind, detail FROM assignment_events WHERE assignment_id = ? AND kind = 'held'").all(held.id) as Array<{ detail: string }>).map((row) => row.detail)[0]).toMatch(/^memory: \d+ running, \d+ ahead$/);
  } finally { db.close(); }
  await expect.poll(() => existsSync(firstRunning), { timeout: 30_000 }).toBe(true);

  await f.cli("send", "--bot", person.id, "--task", person.activeTaskId, "--text", "My own question.");
  await expect.poll(async () => (await f.messages(person.activeTaskId)).some((message: any) => message.tool?.name?.includes("Waiting for memory")), { timeout: 30_000 }).toBe(true);
  writeFileSync(gate, "finish");
  await expect.poll(() => f.ended().includes(second.id) && f.ended().includes(person.id), { timeout: 40_000 }).toBe(true);
  expect(f.ended().indexOf(person.id)).toBeLessThan(f.ended().indexOf(second.id));
}), 120_000);

it("on Starter with 13 bots, hand-offs to busy bots start at once: one thread per bot holds only what a person or a routine starts", () => fixture(async (f) => {
  // A team made before it moved to Starter: the plan limits the bots it makes, never those it has.
  const bots: any[] = [];
  for (let at = 0; at < 13; at += 1) bots.push(await f.bot(`Teammate ${at}`));
  writeFileSync(join(f.dataDir, "test-starter"), "");
  expect((await f.api("/api/config", undefined, "GET")).cloudStarter).toBe(true);
  const [chief, target, other] = bots;
  await f.api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Team"], acknowledgePeerScope: true }, "PATCH");
  const gate = join(f.dataDir, "target-may-finish");
  writeFileSync(f.planPath, JSON.stringify({
    [chief.id]: { steps: [{ arguments: { bot_ids: [target.id], message: "While you are busy" } }, { arguments: { bot_ids: [other.id], message: "Also while busy" } }], reply: "Sent", resumeReply: "Done" },
    [target.id]: { gateFile: gate, reply: "Done" },
    [other.id]: { reply: "Done" },
  }));
  f.free(8 * GB);
  await f.cli("send", "--bot", target.id, "--task", target.activeTaskId, "--text", "Keep busy.");
  await expect.poll(async () => (await f.api("/api/bots?messages=0", undefined, "GET")).bots.find((bot: any) => bot.id === target.id).busy, { timeout: 30_000 }).toBe(true);
  await f.cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Hand these out.");
  const nodes = () => readHandoffs(f.dataDir).filter((node: any) => node.parentId);
  await expect.poll(() => nodes().length, { timeout: 40_000 }).toBe(2);
  await expect.poll(() => nodes().map((node: any) => node.status), { timeout: 5_000, interval: 100 }).toEqual(["running", "running"]);
  writeFileSync(gate, "finish");
  await expect.poll(() => nodes().map((node: any) => node.status), { timeout: 60_000 }).toEqual(["completed", "completed"]);
}), 180_000);

it("a typed stop ends a turn waiting for memory at once and never starts it, and a stop for an idle bot starts nothing", () => fixture(async (f) => {
  const [running, waiting, idle] = [await f.bot("Running"), await f.bot("Waiting"), await f.bot("Idle")];
  const gate = join(f.dataDir, "running-may-finish");
  writeFileSync(f.planPath, JSON.stringify({ [running.id]: { gateFile: gate, reply: "Done" }, [waiting.id]: { reply: "Never" }, [idle.id]: { reply: "Never" } }));
  await f.cli("send", "--bot", running.id, "--task", running.activeTaskId, "--text", "A long job.");
  await expect.poll(async () => (await f.api("/api/bots?messages=0", undefined, "GET")).bots.find((bot: any) => bot.id === running.id).busy, { timeout: 30_000 }).toBe(true);
  await f.cli("send", "--bot", waiting.id, "--task", waiting.activeTaskId, "--text", "Another job.");
  await expect.poll(async () => (await f.messages(waiting.activeTaskId)).some((message: any) => message.tool?.name?.includes("Waiting for memory")), { timeout: 30_000 }).toBe(true);

  const before = Date.now();
  await f.api(`/api/bots/${waiting.id}/messages`, { text: "@everyone alles stoppen", threadId: waiting.activeTaskId });
  await expect.poll(async () => (await f.api("/api/bots?messages=0", undefined, "GET")).bots.find((bot: any) => bot.id === waiting.id).busy, { timeout: 3_000, interval: 50 }).toBe(false);
  expect(Date.now() - before).toBeLessThan(3_000);

  await f.api(`/api/bots/${idle.id}/messages`, { text: "@everyone alles stoppen", threadId: idle.activeTaskId });
  await expect.poll(async () => (await f.messages(idle.activeTaskId)).map((message: any) => message.tool?.name ?? message.text).slice(-2)).toEqual(["@everyone alles stoppen", "Nothing was running here, so nothing needed stopping."]);
  writeFileSync(gate, "finish");
  await expect.poll(async () => (await f.api("/api/bots?messages=0", undefined, "GET")).bots.find((bot: any) => bot.id === running.id).busy, { timeout: 30_000 }).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(f.ended()).toEqual([running.id]);
}), 120_000);
