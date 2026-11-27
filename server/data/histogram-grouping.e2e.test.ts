import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import type { DataHistogram } from "../../shared/data-surface.ts";

const key = "data-histogram-grouping-fixture";
let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
let botId: string;
let token: string;
let next = 0;

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, status?: number): Promise<any> {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { origin: fixture.info.url, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (status !== undefined) expect(response.status, JSON.stringify(result)).toBe(status);
  else expect(response.ok, JSON.stringify(result)).toBe(true);
  return result;
}

beforeAll(async () => {
  fixture = await launchVerificationServer({ OMB_TEST_INTERNAL_CAPABILITY_KEY: key });
  expect(await runControlOmb(["doctor", "--url", fixture.info.url])).toMatchObject({ ok: true });
  const { bot } = await api("POST", "/api/bots", { name: "Histogram grouping" });
  botId = bot.id;
  ({ token } = await api("POST", "/api/testing/internal-capability", { botId, threadId: bot.threadId, kind: "data" }, { "x-openmausbot-test-capability": key }));
}, 60_000);
afterAll(async () => { await fixture?.close(); });

async function table(select: string) {
  const name = `measurements_${++next}`;
  const created = (await api("POST", "/api/internal/data/mcp", {
    method: "tools/call", params: { name: "data_sql", arguments: { sql: `CREATE TABLE ${name} AS ${select}` } },
  }, { authorization: `Bearer ${token}` })).result;
  expect(created.isError, JSON.stringify(created)).not.toBe(true);
  return (column: string, status?: number): Promise<DataHistogram> => api("GET", `/api/bots/${botId}/data/tables/${name}/histogram?column=${encodeURIComponent(column)}&bins=2`, undefined, {}, status);
}

it("groups computed numeric buckets when the inspected column is named bin", async () => {
  const histogram = await table("SELECT range AS bin FROM range(5)");
  expect((await histogram("bin")).bins).toEqual([{ label: "0 – 2", count: 2 }, { label: "2 – 4", count: 3 }]);
});

it("does not group numeric buckets by an unrelated source bin", async () => {
  const histogram = await table("SELECT range AS amount, 99 AS bin FROM range(5)");
  expect((await histogram("amount")).bins).toEqual([{ label: "0 – 2", count: 2 }, { label: "2 – 4", count: 3 }]);
});

it("groups date buckets when the inspected column is named BiN", async () => {
  const histogram = await table("SELECT DATE '2026-01-01' + range::INTEGER AS BiN FROM range(5)");
  expect((await histogram("BiN")).bins).toEqual([{ label: "2026-01-01", count: 2 }, { label: "2026-01-03", count: 3 }]);
});

it("does not group timestamp buckets by an unrelated source bin", async () => {
  const histogram = await table("SELECT TIMESTAMP '2026-01-01' + range * INTERVAL 1 DAY AS moment, 99 AS bin FROM range(5)");
  expect((await histogram("moment")).bins).toEqual([{ label: "2026-01-01 00:00", count: 2 }, { label: "2026-01-03 00:00", count: 3 }]);
});

it.each(["v", "V"])("groups categorical labels independently of a source %s column", async (name) => {
  const histogram = await table(`SELECT * FROM (VALUES ('east', 1), ('east', 2), ('west', 3), (NULL, 4)) t(region, "${name}")`);
  expect((await histogram("region")).bins).toEqual([{ label: "east", count: 2 }, { label: "west", count: 1 }]);
});

it("preserves numeric distributions without a source alias collision", async () => {
  const histogram = await table("SELECT range AS amount FROM range(5)");
  expect((await histogram("amount")).bins).toEqual([{ label: "0 – 2", count: 2 }, { label: "2 – 4", count: 3 }]);
});

it("preserves category counts when the requested column itself is named v", async () => {
  const histogram = await table("SELECT * FROM (VALUES ('east'), ('east'), ('west'), (NULL)) t(v)");
  expect((await histogram("v")).bins).toEqual([{ label: "east", count: 2 }, { label: "west", count: 1 }]);
});

it("still rejects a column that does not exist", async () => {
  const histogram = await table("SELECT 1 AS amount, 99 AS bin");
  expect(await histogram("missing", 400)).toMatchObject({ error: { code: "invalid_input" } });
});
