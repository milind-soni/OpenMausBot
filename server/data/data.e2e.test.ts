// The Data surface through the real server and the real DuckDB: a bot loads a
// CSV, describes it, queries it, shows a table and a chart; the panel reads
// the sheet, pages the table, renders the chart, runs its own SQL, exports,
// renames and removes a card. The bot reaches the tools the way an engine
// does, through the internal MCP route with a turn capability; the panel
// uses the owner's routes. Nothing here asks anyone for approval.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
    const mcp = async (method: string, params?: unknown, token: string = minted.token) =>
      (await api("POST", "/api/internal/data/mcp", { method, params }, 200, { authorization: `Bearer ${token}` })).result;
    const call = async (name: string, args: Record<string, unknown>, token?: string) => {
      const result = await mcp("tools/call", { name, arguments: args }, token);
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
    // The chat receipt names the tool that ran; the card's title is the result's, so a
    // title like "notice: …" can never be read as a status row or a failed turn.
    const receipts = ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as Array<Record<string, any>>)
      .filter((message) => message.dataResult);
    expect(receipts.map((message) => [message.tool.name, message.dataResult.title, message.dataResult.cardId]))
      .toEqual([["data_show", "Totals", tableCard.data.id], ["data_show", "By region", chartCard.data.id]]);

    // A message sent about the viewed result: the words are stored exactly as
    // typed, the context as its own field, and the model gets the hint ahead
    // of the words, on the turn and again when the same words are regenerated.
    const dump = join(dataDir, "fake-claude-dump.json");
    const providerPrompt = async () => {
      await expect.poll(() => existsSync(dump), { timeout: 20_000 }).toBe(true);
      return JSON.parse(readFileSync(dump, "utf8")).prompt.message.content as string;
    };
    const envelope = (prompt: string) => prompt.match(/<data-context>.*?<\/data-context>/g) ?? [];
    const settled = async () => {
      const outcome = await runControlOmb(["wait", "--bot", bot.id, "--task", threadId, "--timeout", "60", "--url", url]) as { status: string };
      expect(outcome.status, JSON.stringify(outcome)).toBe("settled");
    };
    const draftSql = "SELECT region FROM sales WHERE";
    rmSync(dump, { force: true });
    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "Only show north.", dataContext: { cardId: tableCard.data.id, draftSql } }, 202);
    expect(sent.message).toMatchObject({ role: "user", text: "Only show north.", dataContext: { cardId: tableCard.data.id, draftSql } });
    const prompt = await providerPrompt();
    // The envelope opens the turn's text, directly ahead of the person's words
    // (a fresh session may carry replayed history before the turn itself).
    expect(envelope(prompt), prompt).toHaveLength(1);
    expect(prompt.endsWith(`${envelope(prompt)[0]}\n\nOnly show north.`), prompt).toBe(true);
    expect(JSON.parse(envelope(prompt)[0]!.slice("<data-context>".length, -"</data-context>".length))).toMatchObject({ cardId: tableCard.data.id, draftSql, hint: expect.stringContaining("data_describe({id:cardId})") });
    await settled();
    const stored = ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as Array<Record<string, any>>).find((message) => message.id === sent.message.id);
    expect(stored.text).toBe("Only show north.");
    expect(stored.text).not.toContain("<data-context>");
    expect(stored.dataContext).toEqual({ cardId: tableCard.data.id, draftSql });
    // Regenerate resends the same words; the server re-attaches the context itself.
    rmSync(dump, { force: true });
    await api("POST", `/api/bots/${bot.id}/messages/${sent.message.id}/edit`, { threadId, text: "Only show north." }, 202);
    const retried = await providerPrompt();
    expect(envelope(retried), retried).toEqual(envelope(prompt));
    expect(retried.endsWith(`${envelope(prompt)[0]}\n\nOnly show north.`), retried).toBe(true);
    await settled();
    // The boundary: a table name is not a card id.
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "Only show south.", dataContext: { cardId: "sales" } }, 400);

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

    // Opt-in: downloads the real signed extensions into this fixture's empty cache.
    if (process.env.OMB_TEST_DUCKDB_EXTENSIONS === "1") {
      expect(existsSync(join(dataDir, "duckdb-extensions"))).toBe(false);
      const workbook = await call("data_export", { table: "sales", format: "xlsx" });
      expect(workbook.isError, workbook.text).toBe(false);
      expect(readFileSync(workbook.data.path).subarray(0, 2).toString()).toBe("PK");
      // A second instance proves cached extensions load again, without relying on the exporter's LOAD.
      const { bot: reader } = await runControlOmb(["new-bot", "--name", "Workbook reader", "--url", url]) as { bot: { id: string; activeTaskId: string } };
      const readerToken = await api("POST", "/api/testing/internal-capability", { botId: reader.id, threadId: reader.activeTaskId, kind: "data" }, 201, { "x-openmausbot-test-capability": CAPABILITY_KEY });
      const reloaded = await call("data_load", { source: workbook.data.path, name: "workbook_sales" }, readerToken.token);
      expect(reloaded.isError, reloaded.text).toBe(false);
      expect(reloaded.data.tables[0].rowCount).toBe(300);

      const parquet = await call("data_export", { table: "sales", format: "parquet" });
      expect(parquet.isError, parquet.text).toBe(false);
      const files = new Map([["/sales.csv", readFileSync(csv)], ["/sales.parquet", readFileSync(parquet.data.path)], ["/sales.xlsx", readFileSync(workbook.data.path)]]);
      const source = createServer((request, response) => {
        const bytes = files.get(request.url ?? "");
        if (!bytes) { response.writeHead(404).end(); return; }
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        response.writeHead(range ? 206 : 200, {
          "content-length": end - start + 1, "accept-ranges": "bytes",
          ...(range ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}),
        });
        response.end(request.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
      });
      await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
      try {
        const address = source.address() as { port: number };
        for (const format of ["csv", "parquet", "xlsx"]) {
          const remote = await call("data_load", { source: `http://127.0.0.1:${address.port}/sales.${format}`, name: `remote_${format}` });
          expect(remote.isError, remote.text).toBe(false);
          expect(remote.data.tables[0]).toMatchObject({ name: `remote_${format}`, rowCount: 300 });
        }
      } finally {
        source.closeAllConnections();
        await new Promise<void>((resolve, reject) => source.close((error) => error ? reject(error) : resolve()));
      }
      const evidencePath = `${logPath}.data-extensions.json`;
      writeFileSync(evidencePath, JSON.stringify({
        fixtureUrl: url, logPath, freshExtensionCache: true,
        excelExport: { bytes: workbook.data.bytes, rowCount: workbook.data.rowCount },
        excelImportInNewInstance: { rowCount: reloaded.data.tables[0].rowCount },
        remoteLoads: ["csv", "parquet", "xlsx"].map((format) => ({ format, rowCount: 300 })),
      }, null, 2));
      console.info(`Data extension evidence: ${evidencePath}`);
    }
  } finally {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 180_000);
