// A room member whose AI is at its usage limit carries on with a backup, as a bot in its own chat does.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { readUsage } from "./usage-ledger.ts";

const LIMIT = "You've hit your weekly limit · resets Oct 12 at 2:30pm (Asia/Calcutta)";
const BACKUP_REPLY = "done from fake codex";

const jsonLines = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

type Room = { api: (method: string, path: string, body?: unknown) => Promise<any>; send: (text: string, settles?: string) => Promise<void>; messages: () => Promise<any[]>; claudeTurns: () => any[]; usage: () => any[]; serverLog: () => string; bot: any };

/** One room with one member on fake Claude, whose every turn its usage limit refuses, and fake Codex beside it. */
async function withLimitedRoom(choose: (f: { api: (method: string, path: string, body?: unknown) => Promise<any>; bot: any; codex: { instanceId: string; model: string } }) => Promise<void>,
  check: (f: Room) => Promise<void>) {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true }, ["codex"]);
  const { url, dataDir, logPath } = fixture.info;
  const evidence: unknown[] = [{ url }];
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) => handleToolCall(name, args, (path, options) => request(path, options, url)) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result: any = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const planPath = join(dataDir, "room-plan.json");
  try {
    await expect.poll(async () => {
      const { instances } = await api("GET", "/api/instances") as { instances: any[] };
      return instances.find((instance) => instance.instanceId === "codex")?.models.options.length > 0;
    }, { timeout: 30_000 }).toBe(true);
    const { instances } = await api("GET", "/api/instances") as { instances: any[] };
    const codex = { instanceId: "codex", model: instances.find((instance) => instance.instanceId === "codex").models.default as string };
    // A Chief's turn on the same fake Claude would work and end the limit, which a real limit would refuse as well.
    const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; chiefOfStaff?: boolean }> };
    for (const chief of bots.filter((entry) => entry.chiefOfStaff)) await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
    const { bot } = await cli("new-bot", "--name", "Analyst");
    expect(bot.modelSelection?.instanceId ?? (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).modelSelection.instanceId).toBe("claude");
    const { channel } = await tool("create_channel", { name: "Numbers", member_ids: [bot.id] });
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { failWith: LIMIT } }));
    await choose({ api, bot, codex });
    const send = async (text: string, settles = "settled") => {
      await cli("send-channel", "--channel", channel.id, "--text", `@Analyst ${text}`);
      const waited = await cli("wait", "--channel", channel.id, "--timeout", "60");
      evidence.push({ sent: text, wait: waited });
      expect(waited.status).toBe(settles);
    };
    const messages = async () => (await api("GET", `/api/threads/${channel.activeTaskId}/messages?limit=200`)).messages as any[];
    try {
      const usage = () => readUsage(dataDir, { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) }).filter((row) => row.threadId === channel.activeTaskId && row.botId === bot.id);
      await check({ api, send, messages, claudeTurns: () => jsonLines(`${planPath}.evidence.jsonl`).filter((turn) => turn.botId === bot.id), usage, serverLog: () => readFileSync(logPath, "utf8"), bot });
    } finally {
      evidence.push({ messages: await messages() });
    }
  } finally {
    evidence.push({ claudeTurns: jsonLines(`${planPath}.evidence.jsonl`) });
    writeFileSync(`${logPath}.room-limit-takeover.json`, JSON.stringify(evidence, null, 2));
    await fixture.close();
    console.info(JSON.stringify({ logPath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

/** The refused turn is answered once by the backup, the room says which AI took over, and the member's next turn starts
 * on the backup with no refused turn first. The member's own model stays as it was. */
async function carriesOn({ api, send, messages, claudeTurns, usage, bot }: Room) {
  await send("How did October close?");
  expect(claudeTurns()).toHaveLength(1);
  let rows = await messages();
  expect(rows.filter((row) => row.role === "bot" && row.kind === "text" && row.text === BACKUP_REPLY)).toHaveLength(1);
  expect(rows.find((row) => row.role === "bot" && row.kind === "text" && row.text === BACKUP_REPLY)?.from?.botId).toBe(bot.id);
  expect(rows.filter((row) => row.kind === "activity" && /^recovery: .*took over\.$/.test(row.tool?.name ?? ""))).toHaveLength(1);
  expect(rows.filter((row) => row.role === "user")).toHaveLength(1);

  await send("And November so far?");
  expect(claudeTurns(), "the limit is known, so the next turn starts on the backup").toHaveLength(1);
  rows = await messages();
  expect(rows.filter((row) => row.role === "bot" && row.kind === "text" && row.text === BACKUP_REPLY)).toHaveLength(2);
  expect((await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).modelSelection.instanceId).toBe("claude");
  await expect.poll(() => usage().filter((row) => row.instanceId === "codex").length, { timeout: 15_000, message: "each backup turn is booked to the backup" }).toBe(2);
}

it("carries a room member at its usage limit on with that bot's own backup", async () => {
  await withLimitedRoom(async ({ api, bot, codex }) => {
    await api("PATCH", `/api/bots/${bot.id}`, { fallback: [codex] });
  }, carriesOn);
}, 180_000);

it("never sends a room member's turn to the installation's backup, which leaves channels out", async () => {
  await withLimitedRoom(async ({ api, codex }) => {
    await api("PUT", "/api/config", { automaticRecovery: { enabled: true, backup: codex } });
  }, async ({ send, messages, claudeTurns, usage }) => {
    await send("How did October close?", "failed");
    await send("And November so far?", "failed");
    expect(claudeTurns(), "each turn is tried on its own AI, as before").toHaveLength(2);
    const rows = await messages();
    expect(rows.some((row) => row.kind === "text" && row.text === BACKUP_REPLY)).toBe(false);
    expect(rows.some((row) => row.kind === "activity" && /took over/.test(row.tool?.name ?? ""))).toBe(false);
    expect(usage().some((row) => row.instanceId === "codex")).toBe(false);
  });
}, 180_000);

it("keeps a room member on its own AI when none of its own backups can take the turn, and logs why each was passed over", async () => {
  await withLimitedRoom(async ({ api, bot }) => {
    await api("PATCH", `/api/bots/${bot.id}`, { fallback: [{ instanceId: "codex", model: "gpt-gone" }] });
  }, async ({ send, messages, claudeTurns, usage, serverLog }) => {
    await send("How did October close?", "failed");
    await send("And November so far?", "failed");
    expect(claudeTurns(), "each turn is tried on its own AI").toHaveLength(2);
    const rows = await messages();
    expect(rows.some((row) => row.kind === "activity" && /took over/.test(row.tool?.name ?? ""))).toBe(false);
    expect(usage().some((row) => row.instanceId === "codex")).toBe(false);
    await expect.poll(serverLog, { timeout: 15_000 }).toMatch(/limit takeover: Analyst \([^)]+\) on claude\/\S+ \(engine\) passed over backup codex\/gpt-gone: unknown-model/);
  });
}, 180_000);
