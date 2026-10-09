// The Data surface through the real server and the real DuckDB: a bot loads a
// CSV, describes it, queries it, shows a table and a chart; the panel reads
// the sheet, pages the table, renders the chart, runs its own SQL, exports,
// renames and removes a card. The bot reaches the tools the way an engine
// does, through the internal MCP route with a turn capability; the panel
// uses the owner's routes. Nothing here asks anyone for approval.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { DATA_ROUTES, DATA_TOOL_NAMES, type DataCard, type DataSheet } from "../../shared/data-surface.ts";
import { waitForExit } from "../testing/cleanup.ts";

const CAPABILITY_KEY = "data-surface-e2e-capability";

it("loads, queries, shows, pages, renders and exports through the real server", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200, headers: Record<string, string> = {}) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    expect(response.status, `${method} ${path}: ${text.slice(0, 400)}`).toBe(status);
    return text ? JSON.parse(text) as any : null;
  };
  try {
    // Restart the fixture's server with the capability key the bot-side
    // calls need; the launcher's own environment is otherwise kept.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), OMB_TEST_INTERNAL_CAPABILITY_KEY: CAPABILITY_KEY },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);

    const { bot } = await runControlOmb(["new-bot", "--name", "Data bot", "--url", url]) as { bot: { id: string; activeTaskId: string } };
    const threadId = bot.activeTaskId;

    // 300 sales rows over three regions and ten days.
    const regions = ["north", "south", "west"];
    const lines = ["region,amount,day"];
    for (let i = 0; i < 300; i++) lines.push(`${regions[i % 3]},${(i % 17) + 1},2026-10-${String((i % 10) + 1).padStart(2, "0")}`);
    const csv = join(dataDir, "sales.csv");
    writeFileSync(csv, lines.join("\n") + "\n");
    mkdirSync(join(dataDir, "Downloads"), { recursive: true });

    const minted = await api("POST", "/api/testing/internal-capability", { botId: bot.id, threadId, kind: "data" }, 201, { "x-openmausbot-test-capability": CAPABILITY_KEY });
    const mcp = async (method: string, params?: unknown) =>
      (await api("POST", "/api/internal/data/mcp", { method, params }, 200, { authorization: `Bearer ${minted.token}` })).result;
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await mcp("tools/call", { name, arguments: args });
      return { isError: result.isError === true, data: result.structuredContent as Record<string, any>, text: result.content?.[0]?.text as string };
    };

    // The catalog an engine sees: five tools and the dialect notes.
    const listed = await mcp("tools/list");
    expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual([...DATA_TOOL_NAMES]);
    expect(listed.instructions).toMatch(/DuckDB/);

    const loaded = await call("data_load", { source: csv, name: "sales" });
    expect(loaded.isError, loaded.text).toBe(false);
    expect(loaded.data.tables[0]).toMatchObject({ name: "sales", rowCount: 300 });
    expect(loaded.data.tables[0].columns.map((column: { name: string }) => column.name)).toEqual(["region", "amount", "day"]);

    const described = await call("data_describe", { target: "sales" });
    expect(described.isError, described.text).toBe(false);
    const region = described.data.columns.find((column: { name: string }) => column.name === "region");
    expect(region.approxUnique).toBe(3);
    expect(region.sample).toHaveLength(3);

    const totals = await call("data_sql", { sql: "SELECT region, sum(amount) AS total FROM sales GROUP BY ALL ORDER BY total DESC" });
    expect(totals.isError, totals.text).toBe(false);
    expect(totals.data.rowCount).toBe(3);
    expect(totals.data.rows).toHaveLength(3);
    expect(totals.data.table).toMatch(/^omb_results\./);

    // Writes other than CREATE … AS are refused; bad SQL carries DuckDB's own words.
    const refused = await call("data_sql", { sql: "DELETE FROM sales" });
    expect(refused.isError).toBe(true);
    expect(refused.data.code).toBe("write_refused");
    const broken = await call("data_sql", { sql: "SELECT nope FROM sales" });
    expect(broken.isError).toBe(true);
    expect(broken.data).toMatchObject({ code: "sql_error" });
    expect(broken.data.message).toMatch(/nope/);

    const tableCard = await call("data_show", { kind: "table", title: "Totals", sql: "SELECT region, sum(amount) AS total FROM sales GROUP BY ALL ORDER BY total DESC" });
    expect(tableCard.isError, tableCard.text).toBe(false);
    expect(tableCard.data.id).toMatch(/^c_\d+$/);
    const chartCard = await call("data_show", { kind: "chart", title: "By region", table: "sales", chart: { type: "bar", x: "region", y: "amount", agg: "sum" } });
    expect(chartCard.isError, chartCard.text).toBe(false);
    expect(chartCard.data.sheet).toHaveLength(2);

    // The panel: the sheet, a page of the table card, the chart as SVG.
    const read = await api("GET", DATA_ROUTES.sheet(bot.id)) as { sheet: DataSheet; tables: Array<{ name: string }> };
    expect(read.sheet.cards.map((card) => [card.kind, card.title, card.status])).toEqual([["table", "Totals", "ready"], ["chart", "By region", "ready"]]);
    expect(read.sheet.sources.map((source) => source.name)).toEqual(["sales"]);
    expect(read.tables.map((table) => table.name)).toContain("sales");
    expect(read.tables.some((table) => table.name.startsWith("omb_results"))).toBe(false);
    const chart = read.sheet.cards[1] as DataCard;
    expect(chart.vegaLite).toBeTruthy();
    expect(chart.reduction?.inputRows).toBe(300);

    const page = await api("POST", DATA_ROUTES.page(bot.id), { cardId: tableCard.data.id, offset: 0, limit: 100 });
    expect(page.rowCount).toBe(3);
    expect(page.columns.map((column: { name: string }) => column.name)).toEqual(["region", "total"]);
    expect(page.rows[0][1]).toBe(String(Math.max(...regions.map((_, r) => Array.from({ length: 300 }, (_, i) => i % 3 === r ? (i % 17) + 1 : 0).reduce((a, b) => a + b, 0)))));

    const image = await fetch(url + DATA_ROUTES.image(bot.id, chartCard.data.id) + "?format=svg", { headers: { origin: url } });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toMatch(/svg/);
    expect(await image.text()).toMatch(/<svg/);

    // The person runs their own SQL, exports, renames and removes.
    await api("POST", DATA_ROUTES.run(bot.id), { sql: "SELECT count(*) AS n FROM sales", title: "Count" });
    const afterRun = (await api("GET", DATA_ROUTES.sheet(bot.id))).sheet as DataSheet;
    expect(afterRun.cards).toHaveLength(3);
    expect(afterRun.cards[2]).toMatchObject({ title: "Count", by: "person", status: "ready", rowCount: 1 });

    const exported = await api("POST", DATA_ROUTES.export(bot.id), { cardId: tableCard.data.id, format: "csv" });
    expect(exported.path.startsWith(join(dataDir, "Downloads"))).toBe(true);
    expect(existsSync(exported.path)).toBe(true);
    expect(readFileSync(exported.path, "utf8").split("\n")[0]).toBe("region,total");

    await api("PATCH", DATA_ROUTES.card(bot.id, tableCard.data.id), { title: "Totals by region" });
    await api("DELETE", DATA_ROUTES.card(bot.id, afterRun.cards[2]!.id));
    const final = (await api("GET", DATA_ROUTES.sheet(bot.id))).sheet as DataSheet;
    expect(final.cards.map((card) => card.title)).toEqual(["Totals by region", "By region"]);
  } finally {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 180_000);
