import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import type { DataPage, DataSheet } from "../../shared/data-surface.ts";

const key = "data-working-folder-fixture";
let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;

async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { origin: fixture.info.url, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  expect(response.ok, JSON.stringify(result)).toBe(true);
  return result as T;
}

beforeAll(async () => {
  fixture = await launchVerificationServer({ OMB_TEST_INTERNAL_CAPABILITY_KEY: key });
  expect(await runControlOmb(["doctor", "--url", fixture.info.url])).toMatchObject({ ok: true });
}, 60_000);

afterAll(async () => { await fixture?.close(); });

async function task(botId: string, title: string, amount: number) {
  const cwd = join(fixture.info.dataDir, "projects", title);
  mkdirSync(join(cwd, "incoming"), { recursive: true });
  writeFileSync(join(cwd, "report.csv"), `item,amount\n${title},${amount}\n`);
  writeFileSync(join(cwd, "incoming", "report.csv"), `item,amount\n${title},${amount}\n`);
  const { task } = await api<{ task: { threadId: string } }>("POST", `/api/bots/${botId}/tasks`, { title, cwd });
  const { token } = await api<{ token: string }>("POST", "/api/testing/internal-capability", {
    botId, threadId: task.threadId, kind: "data",
  }, { "x-openmausbot-test-capability": key });
  return {
    cwd,
    load: async (source: string, name: string) => {
      const { result } = await api<{ result: { isError?: boolean; content: unknown; structuredContent: unknown } }>("POST", "/api/internal/data/mcp", {
        method: "tools/call", params: { name: "data_load", arguments: { source, name } },
      }, { authorization: `Bearer ${token}` });
      return result;
    },
  };
}

it.each(["report.csv", "./incoming", "incoming/*.csv"])("loads %s from the calling conversation's working folder", async (source) => {
  const { bot } = await api<{ bot: { id: string } }>("POST", "/api/bots", { name: `Data ${source}` });
  const first = await task(bot.id, `north-${bot.id}`, 5);
  const second = await task(bot.id, `south-${bot.id}`, 9);
  for (const [caller, table, amount] of [[first, "north", 5], [second, "south", 9]] as const) {
    const loaded = await caller.load(source, table);
    expect(loaded.isError, JSON.stringify(loaded)).not.toBe(true);
    const page = await api<DataPage>("POST", `/api/bots/${bot.id}/data/page`, { table, offset: 0, limit: 10 });
    expect(page.rows.map((row) => Number(row[1]))).toEqual([amount]);
    const { sheet } = await api<{ sheet: DataSheet }>("GET", `/api/bots/${bot.id}/data`);
    expect(sheet.sources.find((entry) => entry.name === table)?.source).toBe(join(caller.cwd, source));
  }
});

it("keeps an absolute source outside the calling conversation's folder", async () => {
  const { bot } = await api<{ bot: { id: string } }>("POST", "/api/bots", { name: "Absolute Data source" });
  const caller = await task(bot.id, `caller-${bot.id}`, 1);
  const outside = join(fixture.info.dataDir, "absolute-report.csv");
  writeFileSync(outside, "item,amount\nabsolute,42\n");
  const loaded = await caller.load(outside, "absolute_report");
  expect(loaded.isError, JSON.stringify(loaded)).not.toBe(true);
  const page = await api<DataPage>("POST", `/api/bots/${bot.id}/data/page`, { table: "absolute_report", offset: 0, limit: 10 });
  expect(page.rows).toEqual([["absolute", "42"]]);
});
