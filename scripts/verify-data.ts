// Full app + real DuckDB, with synthetic data and a disposable home only.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeBrowserSession } from "../server/browser-engine.ts";
import { waitForExit } from "../server/testing/cleanup.ts";
import { DATA_ROUTES, DATA_TOOL_NAMES, type DataSheet } from "../shared/data-surface.ts";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "./control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv, type UiHandle } from "./testing/control-omb-ui.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

assert(process.argv.slice(2).every((arg) => arg === "--check"), "Usage: node --experimental-strip-types scripts/verify-data.ts [--check]");
const check = process.argv.includes("--check");
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await launchVerificationServer();
const { url, dataDir, logPath } = fixture.info;
const stopped = parkUntilSignal();
const capabilityKey = randomUUID();
let server: ChildProcess | undefined;
let preview: MountedPreview | undefined;
let handle: UiHandle | undefined;

async function until(test: () => Promise<boolean>, message: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  assert(response.ok, `${method} ${path}: ${response.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function startServer() {
  const log = openSync(logPath, "a", 0o600);
  server = spawn(process.execPath, ["--experimental-strip-types", join(root, "server/index.ts")], {
    cwd: root,
    env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), OMB_TEST_INTERNAL_CAPABILITY_KEY: capabilityKey },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  await until(async () => {
    assert(server?.exitCode === null && server?.signalCode === null, `Fixture server exited; see ${logPath}`);
    try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  }, `Fixture server did not start; see ${logPath}`);
}

try {
  // The capability minting route exists only in this restarted fixture server.
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  await startServer();
  await api("PATCH", "/api/config", { language: "en" });
  const { bot } = await runControlOmb(["new-bot", "--name", "Data review", "--url", url]) as { bot: { id: string; activeTaskId: string } };
  const minted = await api("POST", "/api/testing/internal-capability", { botId: bot.id, threadId: bot.activeTaskId, kind: "data" }, { "x-openmausbot-test-capability": capabilityKey });
  const mcp = async (method: string, params?: unknown) =>
    (await api("POST", "/api/internal/data/mcp", { method, params }, { authorization: `Bearer ${minted.token}` })).result;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp("tools/call", { name, arguments: args });
    assert(!result.isError, `${name}: ${JSON.stringify(result.structuredContent ?? result.content)}`);
    return result.structuredContent;
  };
  assert.deepEqual((await mcp("tools/list")).tools.map((tool: { name: string }) => tool.name), [...DATA_TOOL_NAMES]);

  const workspace = join(dataDir, "workspaces", bot.id);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(dataDir, "Downloads"), { recursive: true });
  const csv = join(workspace, "orders.csv");
  const regions = ["India", "Europe", "North America", "東京"];
  const rows = ["order_id,ordered_at,region,product,quantity,revenue,channel,note"];
  for (let i = 0; i < 100_000; i++) {
    rows.push(`${i + 1},2026-09-${String(i % 28 + 1).padStart(2, "0")},${regions[i % 4]},${["Notebook", "Keyboard", "Display"][i % 3]},${i % 5 + 1},${((i % 173 + 1) * 12.5).toFixed(2)},${i % 2 ? "Online" : "Retail"},${i === 99_999 ? "Final order" : i % 97 ? "Subscription renewal" : '"Delivery, then setup"'}`);
  }
  writeFileSync(csv, rows.join("\n") + "\n");
  const loaded = await call("data_load", { source: csv, name: "orders" });
  assert.equal(loaded.tables[0].rowCount, 100_000);
  const events = join(workspace, "events.json");
  writeFileSync(events, JSON.stringify([{ event: "trial", count: 32 }, { event: "paid", count: 18 }, { event: "取消", count: null }]));
  await call("data_load", { source: events, name: "events" });
  const described = await call("data_describe", { target: "orders" });
  assert.equal(described.columns.find((column: { name: string }) => column.name === "region").approxUnique, 4);
  await call("data_sql", { sql: "CREATE TABLE regional_totals AS SELECT region, sum(revenue) AS revenue FROM orders GROUP BY region" });

  for (let i = 1; i <= 17; i++) {
    await call("data_show", { kind: "table", title: `Snapshot ${String(i).padStart(2, "0")}`, sql: `SELECT region, count(*) AS orders, sum(revenue) AS revenue FROM orders WHERE order_id <= ${i * 5000} GROUP BY region ORDER BY region` });
  }
  const regional = await call("data_show", { kind: "chart", title: "Revenue by region", table: "orders", chart: { type: "bar", x: "region", y: "revenue", agg: "sum" } });
  const daily = await call("data_show", { kind: "chart", title: "Daily revenue", table: "orders", chart: { type: "line", x: "ordered_at", y: "revenue", agg: "sum", timeUnit: "day" } });
  const latest = await call("data_show", { kind: "table", title: "All 100,000 orders", sql: "SELECT * FROM orders ORDER BY order_id" });
  const sheet = (await api("GET", DATA_ROUTES.sheet(bot.id))).sheet as DataSheet;
  assert.equal(sheet.cards.length, 20);
  assert(sheet.cards.every((card) => card.status === "ready"));
  const lastPage = await api("POST", DATA_ROUTES.page(bot.id), { cardId: latest.id, offset: 99_990, limit: 10 });
  assert.equal(lastPage.rowCount, 100_000);
  assert.equal(String(lastPage.rows.at(-1)[0]), "100000");
  const filtered = await api("POST", DATA_ROUTES.page(bot.id), { cardId: latest.id, offset: 0, limit: 10, filter: "Final order" });
  assert.equal(filtered.rowCount, 1);
  const sorted = await api("POST", DATA_ROUTES.page(bot.id), { cardId: latest.id, offset: 0, limit: 10, sort: { column: "order_id", direction: "desc" } });
  assert.equal(String(sorted.rows[0][0]), "100000");
  const exported = await api("POST", DATA_ROUTES.export(bot.id), { cardId: regional.id, format: "csv" });
  assert.equal(dirname(exported.path), join(dataDir, "Downloads"));
  assert.match(readFileSync(exported.path, "utf8"), /India/);

  // Materialized card tables and source metadata must survive server restart.
  await waitForExit(server, { signal: "SIGTERM" });
  await startServer();
  const restored = await api("GET", DATA_ROUTES.sheet(bot.id));
  assert.equal(restored.sheet.cards.length, 20);
  assert.deepEqual(restored.sheet.sources.map((source: { name: string }) => source.name).sort(), ["events", "orders"]);
  assert(restored.tables.some((table: { name: string }) => table.name === "regional_totals"));
  assert.equal((await api("POST", DATA_ROUTES.page(bot.id), { cardId: latest.id, offset: 99_999, limit: 1 })).rows[0][7], "Final order");

  preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__data.html", title: "Isolated OMB Data", logLevel: "warn" });
  const { binary, chrome } = await ensureUiBrowser(process.env, (line) => console.error(`Data fixture: ${line}`));
  // The private HOME isolates sessions; one letter fits macOS's socket-path limit.
  handle = { url, previewUrl: preview.previewUrl, binary, chrome, home: dataDir, session: "d", botId: bot.id, logPath };
  await agentBrowser(binary, sessionEnv(handle), ["open", preview.previewUrl], 120_000);
  const handlePath = join(dataDir, "ui.json");
  writeFileSync(handlePath, JSON.stringify(handle, null, 2) + "\n", { mode: 0o600 });
  const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", handlePath, ...args]) as Promise<Record<string, any>>;
  const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
  const click = (name: string) => ui("click", "--name", name);
  const browser = (...args: string[]) => agentBrowser(binary, sessionEnv(handle!), args);
  const drag = async (element: string, dx: number, dy: number) => {
    const { x, y } = await evaluate(`(() => { const { left, top, width, height } = (${element}).getBoundingClientRect(); return { x: Math.round(left + width / 2), y: Math.round(top + height / 2) }; })()`);
    await browser("mouse", "move", String(x), String(y));
    await browser("mouse", "down");
    try {
      for (let step = 1; step <= 4; step++) await browser("mouse", "move", String(Math.round(x + dx * step / 4)), String(Math.round(y + dy * step / 4)));
    } finally { await browser("mouse", "up"); }
  };
  const splitter = "document.querySelector('[data-testid=data-query-resize]')";
  const dragSql = (dy: number) => drag(splitter, 0, dy);
  const resizeValue = () => evaluate(`Number(${splitter}.getAttribute('aria-valuenow'))`) as Promise<number>;
  const keyResize = async (key: string) => {
    await click("Resize SQL editor");
    await ui("press", "--keys", key);
  };
  const preserveQuery = async (resize: () => Promise<void>) => {
    const query = await evaluate(`(() => {
      window.__resizeSql = document.querySelector('[role=textbox][aria-label=SQL]');
      window.__resizeRuns = 0;
      window.__resizeFetch = window.fetch;
      window.fetch = (...args) => { if (String(args[0]).endsWith('/data/run')) window.__resizeRuns++; return window.__resizeFetch(...args); };
      return window.__resizeSql.textContent;
    })()`);
    try {
      await resize();
      assert.equal(await evaluate("window.__resizeRuns"), 0, "Resizing must not execute SQL");
      assert.equal(await evaluate("window.__resizeSql === document.querySelector('[role=textbox][aria-label=SQL]')"), true, "Resizing must not remount the SQL draft");
      assert.equal(await evaluate("window.__resizeSql.textContent"), query, "Resizing must preserve the SQL draft");
    } finally { await evaluate("window.fetch = window.__resizeFetch; true"); }
  };
  const chooseHistory = async (name: string) => {
    await click("History");
    const bounds = await evaluate("(() => { const menu = document.querySelector('[data-testid=data-history] [role=menu]').getBoundingClientRect(); const panel = document.querySelector('[data-testid=data-result]').getBoundingClientRect(); return { top: menu.top, bottom: menu.bottom, left: menu.left, right: menu.right, panelTop: panel.top, panelBottom: panel.bottom, panelLeft: panel.left, panelRight: panel.right }; })()");
    assert(bounds.top >= bounds.panelTop - 1 && bounds.bottom <= bounds.panelBottom + 1 && bounds.left >= bounds.panelLeft - 1 && bounds.right <= bounds.panelRight + 1, `History menu should remain visible within the workspace: ${JSON.stringify(bounds)}`);
    await evaluate(`[...document.querySelectorAll('[data-testid=data-history] [role=menuitemradio]')].find(element => element.textContent.trim() === ${JSON.stringify(name)}).click(); true`);
  };
  const active = "document.querySelectorAll('[data-testid^=data-card-], [data-testid=data-source-view]')";
  const gridCount = "document.querySelector('.data-grid')?.getAttribute('data-row-count')";
  const gridRows = "document.querySelectorAll('.data-grid .ag-row[row-index]')";
  const visibleChart = "[...document.querySelectorAll('[data-testid=data-chart] .vega-embed canvas, [data-testid=data-chart] .vega-embed svg')].find(element => element.checkVisibility({ visibilityProperty: true }))";
  const layout = () => evaluate(`(() => {
    const rect = (element) => { if (!element) return null; const { top, bottom, left, width, height } = element.getBoundingClientRect(); return { top, bottom, left, width, height }; };
    const panel = document.querySelector('[data-testid=data-panel]');
    const splitter = ${splitter};
    const sql = document.querySelector('[data-testid=sql-editor]');
    const sqlStyle = getComputedStyle(document.querySelector('[role=textbox][aria-label=SQL]'));
    const sqlContentHeight = sql.clientHeight - parseFloat(sqlStyle.paddingTop) - parseFloat(sqlStyle.paddingBottom);
    return { panel: rect(panel), sql: rect(sql), sqlContentHeight, sqlLineHeight: parseFloat(sqlStyle.lineHeight), dock: rect(document.querySelector('[data-testid=data-query]')), splitter: rect(splitter), limits: { min: Number(splitter.getAttribute('aria-valuemin')), max: Number(splitter.getAttribute('aria-valuemax')), value: Number(splitter.getAttribute('aria-valuenow')) }, result: rect(document.querySelector('[data-testid=data-result]')), grid: rect(document.querySelector('.data-grid')), viewport: { width: innerWidth, height: innerHeight }, fullscreen: document.fullscreenElement === panel };
  })()`);
  const measureChart = () => evaluate(`(() => { const box = document.querySelector('[data-testid=data-chart]').getBoundingClientRect(); const result = document.querySelector('[data-testid=data-result]').getBoundingClientRect(); const chart = (${visibleChart}).getBoundingClientRect(); return { width: chart.width, height: chart.height, availableWidth: box.width, availableHeight: box.height, top: chart.top, bottom: chart.bottom, visibleTop: result.top, visibleBottom: document.querySelector('[data-testid=data-result-footer]').getBoundingClientRect().top }; })()`);
  const assertDockedLayout = (measurement: Awaited<ReturnType<typeof layout>>) => {
    assert(measurement.result.bottom <= measurement.dock.top + 1, "Result should sit above the SQL dock");
    assert(Math.abs(measurement.result.bottom - measurement.splitter.top) <= 1 && Math.abs(measurement.splitter.bottom - measurement.dock.top) <= 1, "Splitter should separate the result from SQL");
    assert(Math.abs(measurement.panel.bottom - measurement.dock.bottom) <= 2, "SQL dock should stay at the bottom of the workspace");
    assert(measurement.sql.top >= measurement.dock.top && measurement.sql.bottom <= measurement.dock.bottom, "SQL should remain visible inside its dock");
    assert(measurement.sqlContentHeight >= measurement.sqlLineHeight, "SQL should retain one unclipped line even with wrapped table references");
    assert(measurement.limits.value >= measurement.limits.min && measurement.limits.value <= measurement.limits.max && Math.abs(measurement.limits.value - measurement.dock.height) <= 1, "Accessible resize bounds should match the visible SQL dock");
    if (measurement.grid) {
      assert(measurement.result.bottom - measurement.grid.bottom <= 40, "Table leaves unused space above the SQL dock");
      assert(measurement.grid.height >= measurement.result.height * 0.65, "Table should fill the remaining result area");
    }
  };
  const assertFooter = async (count: RegExp, chart = false) => {
    const footer = await evaluate(`(() => {
      const footer = document.querySelector('[data-testid=data-result-footer]');
      const { top, bottom } = footer.getBoundingClientRect();
      const controls = [...footer.querySelectorAll('button, summary[role=button]')].filter(element => element.checkVisibility());
      const panel = document.querySelector('[data-testid=data-panel]').getBoundingClientRect();
      return { text: footer.innerText, top, bottom, dockTop: document.querySelector('[data-testid=data-query]').getBoundingClientRect().top, splitterHeight: document.querySelector('[data-testid=data-query-resize]').getBoundingClientRect().height, labels: controls.map(element => element.getAttribute('aria-label') || element.textContent.trim()), controlsFit: controls.every(element => { const r = element.getBoundingClientRect(); return r.left >= panel.left && r.right <= panel.right && r.top >= top && r.bottom <= bottom; }), scrollWidth: footer.scrollWidth, width: footer.clientWidth };
    })()`);
    assert.match(footer.text, count, "Result footer should show its row and column counts");
    for (const label of ["Export", "History", "Enter fullscreen", ...(chart ? ["Chart", "Table"] : [])]) assert(footer.labels.includes(label), `${label} should share the counts footer`);
    assert(Math.abs(footer.bottom + footer.splitterHeight - footer.dockTop) <= 2, "Result footer should sit immediately above the SQL splitter");
    assert(footer.controlsFit && footer.scrollWidth <= footer.width + 1, "Counts and footer controls should fit inside the panel");
    return footer;
  };
  const receipt = `[data-data-result="${daily.id}"]`;
  const recordedSql = sheet.cards.find((card) => card.id === daily.id)?.sql;
  const openReceipt = () => evaluate(`[...document.querySelectorAll('${receipt} button')].find(element => element.textContent.includes('Open in Data')).click(); true`);
  const toggleReceiptSql = () => evaluate(`document.querySelector('${receipt} button[aria-expanded]').click(); true`);
  const receiptSelected = `document.querySelector('[data-tour=computer-data]')?.getAttribute('aria-pressed') === 'true' && ${active}.length === 1 && ${active}[0].getAttribute('data-card-id') === ${JSON.stringify(daily.id)}`;
  await until(async () => await evaluate("!!document.querySelector('textarea[aria-label=\"Message Data review\"]')"), "Seeded conversation did not mount");
  console.log(JSON.stringify({ ok: true, ui: handlePath, ...fixture.info, pid: server?.pid, previewUrl: preview.previewUrl, botId: bot.id, rows: 100_000, cards: 20, serverChecks: "load, describe, SQL, charts, paging, filter, sort, export, restart" }, null, 2));
  if (check) {
    if (await evaluate("!!document.querySelector('[data-tour=computer-data]')")) await click("Close computer panel");
    await until(async () => await evaluate("!document.querySelector('[data-tour=computer-data]')"), "Computer panel did not close");
    await until(async () => await evaluate(`!!document.querySelector('${receipt} button')`), "Older chart's inline receipt did not render");
    await toggleReceiptSql();
    assert.equal(await evaluate(`document.querySelector('${receipt} pre code')?.textContent`), recordedSql, "Expanded receipt should show the bot's recorded SQL");
    await ui("screenshot", "--out", logPath + ".data-recorded-sql.png");
    await toggleReceiptSql();
    assert.equal(await evaluate(`document.querySelector('${receipt} pre') === null`), true, "Recorded SQL should collapse");
    await openReceipt();
    await until(async () => await evaluate(receiptSelected), "First receipt did not mount its Data result");
    await ui("wait-settle", "--timeout", "30");
    assert.equal(await evaluate(receiptSelected), true, "First receipt lost its Data selection after configuration settled");
    await click("Browser");
    await click("Close computer panel");
    await until(async () => await evaluate("!document.querySelector('[data-tour=computer-data]')"), "Computer panel did not close after Browser selection");
    await click("Bot's computer");
    await ui("wait-settle", "--timeout", "30");
    assert.equal(await evaluate("document.querySelector('[data-tour=computer-browser]')?.getAttribute('aria-pressed') === 'true' && !document.querySelector('[data-testid=data-panel]')"), true, "Consumed receipt replaced Browser when reopening the panel");
    await openReceipt();
    await until(async () => await evaluate(receiptSelected), "Clicking the receipt again did not mount its Data result");
    await ui("wait-settle", "--timeout", "30");
    assert.equal(await evaluate(receiptSelected), true, "Clicking the receipt again did not reopen its Data result");
    await chooseHistory("Latest result");
  } else {
    if (!await evaluate("!!document.querySelector('[data-tour=computer-data]')")) await click("Bot's computer");
    await click("Data");
  }

  if (!check) {
    await stopped;
  } else {
    await until(async () => await evaluate(`${active}.length === 1 && ${gridCount} === '100000' && ${gridRows}.length > 0`), "Latest 100k-row result did not become the only active result");
    await until(async () => await evaluate("document.querySelector('.data-grid .ag-row[row-index=\"0\"] .ag-cell[col-id=order_id]')?.textContent === '1'"), "First page did not load");
    assert.equal(await evaluate("document.querySelector('[role=textbox][aria-label=SQL]')?.checkVisibility()"), true, "SQL should always be visible");
    assert.equal(await evaluate("document.querySelectorAll('[role=textbox][aria-label=SQL]').length"), 1);
    assert.equal(await evaluate("document.querySelector('[data-testid=data-details-toggle]') === null"), true);
    assert.equal(await evaluate(`${active}[0].querySelector('header, h1, h2, h3') === null`), true, "Result should not display a title header");
    const normalLayout = await layout();
    assertDockedLayout(normalLayout);
    const tableFooter = await assertFooter(/100,000 rows\s*·\s*8 columns/);
    const headerNames = await evaluate("[...document.querySelectorAll('.data-grid .ag-header-cell-text')].map(cell => cell.textContent.trim())") as string[];
    assert(headerNames.length > 0 && headerNames.every((name) => sheet.cards.find((card) => card.id === latest.id)?.columns?.some((column) => column.name === name)), "Column types should not clutter the visible column names");
    const initialRows = await evaluate(`${gridRows}.length`);
    assert(initialRows > 0 && initialRows < 100, `Expected bounded rows, received ${initialRows}`);
    await ui("screenshot", "--out", logPath + ".data-grid.png");
    await click("Enter fullscreen");
    await until(async () => await evaluate("document.fullscreenElement === document.querySelector('[data-testid=data-panel]')"), "Data workspace did not enter native fullscreen");
    const fullscreenLayout = await layout();
    assert(fullscreenLayout.panel.width >= fullscreenLayout.viewport.width - 4 && fullscreenLayout.panel.height >= fullscreenLayout.viewport.height - 4, "Fullscreen workspace should fill the viewport");
    assert(fullscreenLayout.panel.width > normalLayout.panel.width + 100, "Fullscreen should expand the result workspace");
    assertDockedLayout(fullscreenLayout);
    assert.equal(await evaluate(gridCount), "100000");
    await ui("screenshot", "--out", logPath + ".data-fullscreen.png");
    await click("Exit fullscreen");
    await until(async () => await evaluate("document.fullscreenElement === null"), "Data workspace did not exit native fullscreen");
    await until(async () => Math.abs((await layout()).panel.width - normalLayout.panel.width) < 2, "Exiting fullscreen did not restore the panel width");
    assert.equal(await evaluate("document.querySelector('[role=textbox][aria-label=SQL]').textContent"), latest.sql ?? sheet.cards.find((card) => card.id === latest.id)?.sql);
    await evaluate("(() => { const grid = document.querySelector('.data-grid .ag-grid-viewport'); grid.scrollTop = grid.scrollHeight; return true; })()");
    await until(async () => await evaluate("document.querySelector('.data-grid .ag-row[row-index=\"99999\"] .ag-cell[col-id=order_id]')?.textContent === '100000'"), "Scrolling did not fetch the final row");
    const finalRows = await evaluate(`${gridRows}.length`);
    assert(finalRows > 0 && finalRows < 100, `Expected bounded rows at the end, received ${finalRows}`);
    await chooseHistory("Daily revenue");
    await until(async () => await evaluate(`!!${visibleChart} && ${active}.length === 1`), "History chart did not render alone");
    await click("Table");
    await until(async () => await evaluate("!!document.querySelector('[data-testid=data-card-chart] .data-grid .ag-root')"), "Chart table toggle did not mount the grid");
    await click("Chart");
    await until(async () => await evaluate("document.querySelectorAll('[data-testid=data-card-chart] .data-grid').length === 0"), "Chart toggle kept its table mounted");
    await until(async () => await evaluate(`!!${visibleChart}`), "Chart did not remount");
    const chartLayout = await measureChart();
    assert(chartLayout.width > 100 && chartLayout.height > 100 && chartLayout.width <= chartLayout.availableWidth + 2 && chartLayout.height <= chartLayout.availableHeight + 2, "Chart should fit its result area");
    assert(chartLayout.top >= chartLayout.visibleTop && chartLayout.bottom <= chartLayout.visibleBottom + 1, "Chart axes should be visible without scrolling behind the SQL dock");
    assert(chartLayout.height / chartLayout.width >= 0.2 && chartLayout.height / chartLayout.width <= 1.2, "Chart has an unusable aspect ratio");
    const chartFooter = await assertFooter(/28 rows\s*·\s*2 columns/, true);
    assert.equal(await evaluate(`${active}[0].querySelector('header, h1, h2, h3') === null`), true, "Chart should not display a title header");
    await ui("screenshot", "--out", logPath + ".data-chart.png");
    await click("Enter fullscreen");
    await until(async () => await evaluate("document.fullscreenElement === document.querySelector('[data-testid=data-panel]')") && (await measureChart()).width > chartLayout.width + 100, "Chart did not resize for native fullscreen");
    const chartFullscreen = await measureChart();
    assert(chartFullscreen.top >= chartFullscreen.visibleTop && chartFullscreen.bottom <= chartFullscreen.visibleBottom + 1 && chartFullscreen.height >= chartLayout.height, "Fullscreen chart should fit the larger result area");
    await ui("screenshot", "--out", logPath + ".data-chart-fullscreen.png");
    await click("Exit fullscreen");
    await until(async () => await evaluate("document.fullscreenElement === null") && Math.abs((await measureChart()).width - chartLayout.width) < 2, "Chart did not resize back after fullscreen");
    assert.equal(await evaluate("document.querySelector('[role=textbox][aria-label=SQL]')?.checkVisibility()"), true, "Chart SQL should remain visible");
    assert.equal(await evaluate("document.querySelector('[role=textbox][aria-label=SQL]').textContent"), sheet.cards.find((card) => card.id === daily.id)?.sql);
    assert.equal(await evaluate("document.querySelectorAll('[data-testid=sources-strip] button, [data-testid=sources-strip] svg').length"), 0, "Table references should be plain text");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-testid=sources-strip] li')].map(row => row.textContent)"), ["events3 rows", "orders100,000 rows", "regional_totals4 rows"]);
    await chooseHistory("Latest result");
    await until(async () => await evaluate(`${gridCount} === '100000'`), "Latest result did not restore the 100k table");
    // A new result arrives over the real event stream and replaces the viewer.
    await api("POST", DATA_ROUTES.run(bot.id), { sql: "SELECT count(*) AS order_count FROM orders", title: "Live order count" });
    const beforeEdits = (await api("GET", DATA_ROUTES.sheet(bot.id))).sheet as DataSheet;
    const countCard = beforeEdits.cards.find((card) => card.title === "Live order count")!;
    await until(async () => await evaluate(`${active}.length === 1 && ${active}[0].getAttribute('data-card-id') === ${JSON.stringify(countCard.id)} && ${active}[0].querySelector('.ag-cell')?.textContent === '100000'`), "New result did not replace the active viewer");
    assert.deepEqual(((await ui("console")).messages ?? []).filter((message: { type: string }) => message.type === "error"), []);
    await until(async () => await evaluate("document.querySelector('[role=textbox][aria-label=SQL]')?.textContent === 'SELECT count(*) AS order_count FROM orders'"), "SQL box did not start with the selected result's query");
    const typeSql = async (sql: string) => {
      await click("SQL");
      await ui("press", "--keys", process.platform === "darwin" ? "Meta+a" : "Control+a");
      await ui("press", "--keys", "Backspace");
      await ui("type", "--name", "SQL", "--text", sql);
    };
    const delayedSql = "SELECT stale_column FROM orders";
    // Hold one real error response while a newer query completes. DuckDB and
    // the HTTP routes remain real; only delivery order to the renderer changes.
    await evaluate(`(() => {
      const originalFetch = window.fetch.bind(window);
      window.__sqlErrors = 0;
      window.__dataOriginalFetch = async (input, init) => {
        const response = await originalFetch(input, init);
        if (String(input).endsWith('/data/run') && [400, 404, 409, 422].includes(response.status)) window.__sqlErrors++;
        return response;
      };
      window.__dataCheck = { held: false, release: null, holdChartPage: false, chartPageHeld: false, chartWait: null, releaseChart: null };
      window.fetch = async (input, init) => {
        const response = await window.__dataOriginalFetch(input, init);
        if (String(input).endsWith('/data/run')) {
          if (JSON.parse(init.body).sql === ${JSON.stringify(delayedSql)}) {
            window.__dataCheck.held = true;
            await new Promise(resolve => { window.__dataCheck.release = resolve; });
          }
        }
        if (String(input).endsWith('/data/page') && JSON.parse(init.body).cardId === ${JSON.stringify(daily.id)} && window.__dataCheck.holdChartPage) {
          window.__dataCheck.chartPageHeld = true;
          await window.__dataCheck.chartWait;
        }
        return response;
      };
      return true;
    })()`);
    let expectedSqlErrors = 0;
    let chartEditLayout: { before: number; pending: number; after: number } | undefined;
    type SqlBounds = { top: number; bottom: number; height: number };
    const sqlBounds = () => evaluate("(() => { const { top, bottom, height } = document.querySelector('[data-testid=sql-editor]').getBoundingClientRect(); return { top, bottom, height }; })()") as Promise<SqlBounds>;
    let validationEditLayout: { before: SqlBounds; invalid: SqlBounds; after: SqlBounds } | undefined;
    const resizing: Record<string, unknown> = {};
    try {
      const sqlBeforeInvalid = await sqlBounds();
      await typeSql("SELECT * FROM");
      await until(async () => await evaluate("!!document.querySelector('[data-testid=data-panel] [role=alert]')"), "Invalid SQL did not report its error");
      assert.match(await evaluate("document.querySelector('[data-testid=data-panel] [role=alert]').textContent"), /syntax|parser/i, "Invalid SQL should show DuckDB's error message");
      assert.equal(await evaluate(`${active}[0].querySelector('.ag-cell')?.textContent`), "100000", "Invalid SQL replaced the last good result");
      assert.equal(await evaluate(`${active}[0].getAttribute('data-card-id')`), countCard.id);
      const sqlWhileInvalid = await sqlBounds();
      for (const dimension of ["top", "bottom", "height"] as const) assert(Math.abs(sqlWhileInvalid[dimension] - sqlBeforeInvalid[dimension]) < 1, `SQL ${dimension} changed when validation failed`);
      await preserveQuery(async () => {
        const before = await resizeValue();
        await dragSql(-24);
        await until(async () => (await resizeValue()) > before + 20, "Dragging did not grow the invalid SQL draft");
        await dragSql(24);
        await until(async () => Math.abs((await resizeValue()) - before) <= 1, "Dragging did not restore the invalid SQL draft height");
        assert.match(await evaluate("document.querySelector('[data-testid=data-query-error]').textContent"), /syntax|parser/i);
      });
      resizing.invalidDraftPreserved = true;
      const validSql = "SELECT order_id, region FROM orders ORDER BY order_id LIMIT 12";
      await typeSql(validSql);
      await until(async () => await evaluate(`${gridCount} === '12' && !document.querySelector('[data-testid=data-panel] [role=alert]')`), "Typed SQL did not update the result without Run");
      const sqlAfterValid = await sqlBounds();
      for (const dimension of ["top", "bottom", "height"] as const) assert(Math.abs(sqlAfterValid[dimension] - sqlBeforeInvalid[dimension]) < 1, `SQL ${dimension} changed after validation recovered`);
      validationEditLayout = { before: sqlBeforeInvalid, invalid: sqlWhileInvalid, after: sqlAfterValid };
      // One more keystroke updates the same result immediately: 12 → 120 rows.
      await ui("type", "--name", "SQL", "--text", "0");
      await until(async () => await evaluate(`${gridCount} === '120'`), "Single-character edit did not update the row count");
      await typeSql(delayedSql);
      await until(async () => await evaluate("window.__dataCheck.held"), "Older SQL response was not held");
      const newestSql = "SELECT order_id, region FROM orders ORDER BY order_id LIMIT 9";
      await typeSql(newestSql);
      await until(async () => await evaluate(`${gridCount} === '9'`), "Newest edit did not win while an older response was pending");
      await evaluate("window.__dataCheck.release(); true");
      await ui("wait-settle", "--timeout", "30");
      assert.equal(await evaluate(gridCount), "9");
      assert.equal(await evaluate("document.querySelector('[data-testid=data-panel] [role=alert]') === null"), true, "Stale SQL error replaced the newest result");
      assert.equal(await evaluate("document.querySelector('[role=textbox][aria-label=SQL]').textContent"), newestSql);
      const edited = (await api("GET", DATA_ROUTES.sheet(bot.id))).sheet as DataSheet;
      assert.equal(edited.cards.length, beforeEdits.cards.length, "Live typing created extra history cards");
      assert.deepEqual(edited.cards.filter((card) => card.id === countCard.id).map(({ kind, title, rowCount, sql, status }) => ({ kind, title, rowCount, sql, status })), [{ kind: "table", title: "Live order count", rowCount: 9, sql: newestSql, status: "ready" }]);
      await chooseHistory("Daily revenue");
      await until(async () => await evaluate(`!!${visibleChart}`), "History chart did not load before editing");
      const sqlTopBefore = await evaluate(`(() => {
        window.__previousDataChart = ${visibleChart};
        window.__previousChartBytes = window.__previousDataChart.tagName === 'CANVAS' ? window.__previousDataChart.toDataURL() : window.__previousDataChart.outerHTML;
        // Per-keystroke SQL can commit multiple valid revisions. Hold all of
        // their page responses, not just the first intermediate revision.
        window.__dataCheck.holdChartPage = true;
        window.__dataCheck.chartWait = new Promise(resolve => { window.__dataCheck.releaseChart = () => { window.__dataCheck.holdChartPage = false; resolve(); }; });
        return document.querySelector('[data-testid=sql-editor]').getBoundingClientRect().top;
      })()`);
      const chartSql = "SELECT * FROM orders WHERE ordered_at < DATE '2026-09-03'";
      await typeSql(chartSql);
      await until(async () => await evaluate("window.__dataCheck.chartPageHeld"), "Edited chart page response was not held");
      const pendingChart = await evaluate(`(() => { const chart = ${visibleChart}; return { originalConnected: window.__previousDataChart.isConnected, originalVisible: window.__previousDataChart.checkVisibility({ visibilityProperty: true }), currentVisible: !!chart }; })()`);
      assert(pendingChart.originalConnected && pendingChart.originalVisible, `Chart disappeared while its replacement rows were pending: ${JSON.stringify(pendingChart)}`);
      const sqlTopPending = await evaluate("document.querySelector('[data-testid=sql-editor]').getBoundingClientRect().top");
      assert(Math.abs(sqlTopPending - sqlTopBefore) < 1, "SQL box moved while chart rows were pending");
      await evaluate("window.__dataCheck.releaseChart(); true");
      await until(async () => {
        const updated = ((await api("GET", DATA_ROUTES.sheet(bot.id))).sheet as DataSheet).cards.find((card) => card.id === daily.id);
        return updated?.sql === chartSql && updated.kind === "chart" && updated.rowCount === 2;
      }, "Live SQL did not preserve the chart and reduce it to two days");
      await until(async () => await evaluate(`!!${visibleChart} && !document.querySelector('[data-testid=data-panel] [role=alert]')`), "Edited chart did not render");
      await until(async () => await evaluate(`(() => { const chart = ${visibleChart}; return !!chart && (chart.tagName === 'CANVAS' ? chart.toDataURL() : chart.outerHTML) !== window.__previousChartBytes; })()`), "Edited chart never displayed its replacement data");
      const sqlTopAfter = await evaluate("document.querySelector('[data-testid=sql-editor]').getBoundingClientRect().top");
      assert(Math.abs(sqlTopAfter - sqlTopBefore) < 1, "SQL box moved after the replacement chart rendered");
      chartEditLayout = { before: sqlTopBefore, pending: sqlTopPending, after: sqlTopAfter };
      assert.equal(await evaluate(`${active}[0].getAttribute('data-card-id')`), daily.id);
      await toggleReceiptSql();
      assert.equal(await evaluate(`document.querySelector('${receipt} pre code')?.textContent`), recordedSql, "Editing the viewer should not rewrite the bot's recorded SQL receipt");
      assert.notEqual(recordedSql, chartSql);
      await toggleReceiptSql();
      await click("Table");
      await until(async () => await evaluate(`${gridCount} === '2'`), "Edited chart's table did not contain two rows");
      await click("Chart");
      expectedSqlErrors = await evaluate("window.__sqlErrors");
      assert(expectedSqlErrors >= 2, "The real server did not reject both invalid queries");
      await ui("screenshot", "--out", logPath + ".data-live-sql.png");
    } finally {
      await evaluate("window.__dataCheck.release?.(); window.__dataCheck.releaseChart?.(); window.fetch = window.__dataOriginalFetch; true");
    }
    const beforeResizeCards = ((await api("GET", DATA_ROUTES.sheet(bot.id))).sheet as DataSheet).cards;
    const resizeScreenshots: string[] = [];
    const recordResize = async (phase: string, chart = false) => {
      const measured = await layout();
      assertDockedLayout(measured);
      let plot;
      let rows;
      if (chart) {
        await until(async () => {
          const current = await measureChart();
          return current.bottom <= current.visibleBottom + 1 && current.width <= current.availableWidth + 1 && current.height <= current.availableHeight + 1;
        }, "Chart did not fit after resizing SQL");
        plot = await measureChart();
        assert(plot.height > 50 && plot.width > 100, "Chart should retain a usable plot after resizing SQL");
      } else {
        rows = await evaluate(`(() => { const viewport = document.querySelector('.data-grid .ag-grid-viewport').getBoundingClientRect(); const header = document.querySelector('.data-grid .ag-header-cell').getBoundingClientRect(); const rows = [...${gridRows}]; return { mounted: rows.length, visible: rows.filter(row => { const r = row.getBoundingClientRect(); return r.bottom > Math.max(viewport.top, header.bottom) && r.top < viewport.bottom; }).length }; })()`);
        assert(rows.mounted > 0 && rows.mounted < 100 && rows.visible > 0, "Resized table should retain visible rows with a bounded DOM");
      }
      resizing[phase] = { ...measured, plot, rows };
      const screenshot = `${logPath}.data-resize-${phase}.png`;
      resizeScreenshots.push(screenshot);
      await ui("screenshot", "--out", screenshot);
    };
    const clampDock = async (maximum: boolean) => {
      const current = await layout();
      const target = maximum ? current.panel.top + 1 : current.panel.bottom - 1;
      await dragSql(target - current.splitter.top - current.splitter.height / 2);
      await until(async () => {
        const next = await layout();
        return Math.abs(next.limits.value - (maximum ? next.limits.max : next.limits.min)) <= 1;
      }, `Pointer drag did not clamp SQL to its ${maximum ? "maximum" : "minimum"}`);
    };
    await chooseHistory("All 100,000 orders");
    await until(async () => await evaluate(`${gridCount} === '100000' && ${gridRows}.length > 0`), "Large table did not load for splitter checks");
    await preserveQuery(async () => {
      const originalHeight = await resizeValue();
      await dragSql(-48);
      await until(async () => (await resizeValue()) > originalHeight + 40, "Pointer drag up did not enlarge SQL");
      await recordResize("table-grown");
      await dragSql(48);
      await until(async () => Math.abs((await resizeValue()) - originalHeight) <= 1, "Pointer drag down did not shrink SQL");
      await keyResize("ArrowUp");
      assert(Math.abs((await resizeValue()) - originalHeight - 24) <= 1, "ArrowUp should grow SQL by 24px");
      await keyResize("ArrowDown");
      assert(Math.abs((await resizeValue()) - originalHeight) <= 1, "ArrowDown should restore SQL height");
      await clampDock(true);
      const maximum = await resizeValue();
      await keyResize("ArrowUp");
      assert.equal(await resizeValue(), maximum, "Keyboard resizing must respect the maximum");
      await recordResize("table-max");
      await chooseHistory("All 100,000 orders");
      await clampDock(false);
      const minimum = await resizeValue();
      await keyResize("ArrowDown");
      assert.equal(await resizeValue(), minimum, "Keyboard resizing must respect the minimum");
      await recordResize("table-min");
      await drag("document.querySelector('[data-testid=data-panel]').closest('aside').querySelector(':scope > [role=separator]')", 40, 0);
      await browser("set", "viewport", "1280", "460");
      await until(async () => {
        const current = await layout();
        return current.panel.width >= 350 && current.panel.width <= 361 && current.panel.height < 400;
      }, "Narrow/short Data panel did not settle");
      await clampDock(true);
      await recordResize("table-narrow-short");
      await assertFooter(/100,000 rows\s*·\s*8 columns/);
      await chooseHistory("All 100,000 orders");
    });
    await chooseHistory("Daily revenue");
    await until(async () => await evaluate(`!!${visibleChart}`), "Chart did not load for splitter checks");
    await preserveQuery(async () => {
      await clampDock(false);
      await recordResize("chart-narrow-min", true);
      await clampDock(true);
      await recordResize("chart-narrow-max", true);
      await assertFooter(/2 rows\s*·\s*2 columns/, true);
      await chooseHistory("Daily revenue");
      await click("Enter fullscreen");
      await until(async () => await evaluate("document.fullscreenElement === document.querySelector('[data-testid=data-panel]')"), "Resizable SQL workspace did not enter fullscreen");
      await clampDock(true);
      await recordResize("chart-fullscreen-max", true);
      await clampDock(false);
      await recordResize("chart-fullscreen-min", true);
      await click("Exit fullscreen");
      await until(async () => await evaluate("document.fullscreenElement === null"), "Resizable SQL workspace did not exit fullscreen");
      await recordResize("chart-restored", true);
    });
    assert.deepEqual(((await api("GET", DATA_ROUTES.sheet(bot.id))).sheet as DataSheet).cards, beforeResizeCards, "Resizing should not change stored queries or results");
    resizing.queryRequests = 0;
    await browser("set", "viewport", String(normalLayout.viewport.width), String(normalLayout.viewport.height));
    const wideSql = `SELECT i+1 AS "order.id", 9007199254740993::BIGINT+i AS "big id", i%2=0 AS "is active?", CASE WHEN i%2=0 THEN NULL ELSE 'present' END AS "nullable value", CASE WHEN i=99999 THEN 'Final typed row' ELSE '東京' END AS "label []", ${Array.from({ length: 115 }, (_, i) => `i+${i} AS "metric.${String(i).padStart(2, "0")}"`).join(", ")} FROM range(100000) AS generated(i)`;
    await api("POST", DATA_ROUTES.run(bot.id), { sql: wideSql, title: "Wide typed values" });
    const wideCard = ((await api("GET", DATA_ROUTES.sheet(bot.id))).sheet as DataSheet).cards.find((card) => card.title === "Wide typed values")!;
    const widePage = await api("POST", DATA_ROUTES.page(bot.id), { cardId: wideCard.id, offset: 0, limit: 2 });
    assert.equal(widePage.columns.length, 120);
    assert.deepEqual(widePage.rows[0].slice(1, 5), ["9007199254740993", true, null, "東京"]);
    await until(async () => await evaluate("[...document.querySelectorAll('[data-testid=data-history] [role=menuitemradio]')].some(element => element.textContent === 'Wide typed values')"), "Wide result did not enter History");
    await chooseHistory("Wide typed values");
    const cell = (row: number, column: string) => `document.querySelector(${JSON.stringify(`.data-grid .ag-row[row-index="${row}"] .ag-cell[col-id="${column}"]`)})`;
    await until(async () => await evaluate(`${cell(0, "order.id")}?.textContent === '1'`), "Wide grid did not load its first page");
    assert.equal(await evaluate("document.querySelector('.data-grid button[aria-label=\"Copy rows\"]') === null"), true, "Grid should not add a top copy button");
    await evaluate(`(() => {
      window.__gridFetch = window.fetch;
      window.__gridRequests = [];
      window.__gridFailNext = false;
      window.__gridClipboard = navigator.clipboard.writeText;
      window.__gridCopied = null;
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.__gridCopied = text; } });
      window.fetch = (...args) => {
        if (String(args[0]).endsWith('/data/page')) {
          window.__gridRequests.push(JSON.parse(args[1].body));
          if (window.__gridFailNext) { window.__gridFailNext = false; return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Fixture page unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } })); }
        }
        return window.__gridFetch(...args);
      };
      return true;
    })()`);
    const agGrid: Record<string, unknown> = { rows: 100_000, columns: 120 };
    try {
      const header = '.data-grid .ag-header-cell[col-id="order.id"]';
      for (const [direction, first] of [["asc", "1"], ["desc", "100000"]]) {
        await browser("click", header + " .ag-header-cell-label");
        await until(async () => await evaluate(`${cell(0, "order.id")}?.textContent === ${JSON.stringify(first)} && window.__gridRequests.some(request => request.sort?.column === 'order.id' && request.sort?.direction === ${JSON.stringify(direction)})`), `Server-side ${direction} sort did not replace the page`);
      }
      await browser("click", header + " .ag-header-cell-label");
      await until(async () => await evaluate(`${cell(0, "order.id")}?.textContent === '1'`), "Clearing sort did not restore source order");
      const headerWidth = await evaluate(`document.querySelector(${JSON.stringify(header)}).getBoundingClientRect().width`);
      await drag(`document.querySelector(${JSON.stringify(header + " .ag-header-cell-resize")})`, 70, 0);
      assert((await evaluate(`document.querySelector(${JSON.stringify(header)}).getBoundingClientRect().width`)) > headerWidth + 60, "Native column drag did not resize the column");
      const setFilter = async (value: string, column = "All columns") => {
        await click("Filter");
        if (await evaluate("!!document.querySelector('input[aria-label=\"Filter value\"]')")) await click("Choose column");
        if (column === "All columns") await click(column);
        else await browser("click", `[data-filter-option][aria-label=${JSON.stringify(column)}]`);
        await click("Filter value");
        await evaluate("document.querySelector('input[aria-label=\"Filter value\"]').select(); true");
        await ui("press", "--keys", "Backspace");
        if (value) await ui("type", "--name", "Filter value", "--text", value);
        await ui("press", "--keys", "Escape");
      };
      assert.equal(await evaluate("!!document.querySelector('input[aria-label=\"Filter rows\"]')"), false, "Grid should show a compact Filter button instead of an always-visible search");
      await click("Filter");
      await ui("type", "--name", "Search columns", "--text", "label");
      assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-filter-option]')].map(button => button.textContent.trim())"), ["All columns", "label []"]);
      await ui("screenshot", "--out", logPath + ".data-filter-menu.png");
      await ui("press", "--keys", "Escape");
      assert.equal(await evaluate("document.activeElement?.getAttribute('aria-label')"), "Filter", "Escape should return focus to Filter");
      await setFilter("Final typed row", "order.id");
      await until(async () => await evaluate(`${gridCount} === '0'`), "Column filter unexpectedly searched other columns");
      await setFilter("100000", "order.id");
      await until(async () => await evaluate(`${gridCount} === '1' && ${cell(0, "order.id")}?.textContent === '100000'`), "Column filter did not reach the final numeric row");
      assert.equal(await evaluate("window.__gridRequests.some(request => request.filter === '100000' && request.filterColumn === 'order.id')"), true);
      await setFilter("Final typed row");
      await until(async () => await evaluate(`${gridCount} === '1' && ${cell(0, "order.id")}?.textContent === '100000'`), "Global search did not find the hidden-column value on the last server row");
      assert.equal(await evaluate("window.__gridRequests.some(request => request.filter === 'Final typed row')"), true);
      await setFilter("__no_synthetic_match__");
      await until(async () => await evaluate(`${gridCount} === '0' && ${gridRows}.length === 0`), "Empty filter result did not clear the grid");
      await setFilter("");
      await until(async () => await evaluate(`${gridCount} === '100000' && ${cell(0, "order.id")}?.textContent === '1'`), "Clearing the filter did not restore rows");
      await evaluate("window.__gridFailNext = true; true");
      await setFilter("Final typed row");
      await until(async () => await evaluate("document.querySelector('.data-grid [role=alert]')?.textContent.includes('Fixture page unavailable') === true"), "Page failure did not show a recoverable error");
      await setFilter("");
      await until(async () => await evaluate(`${gridCount} === '100000' && ${cell(0, "order.id")}?.textContent === '1' && !document.querySelector('.data-grid [role=alert]')`), "Changing filter did not recover from the failed page");
      await click("Enter fullscreen");
      await until(async () => await evaluate(`document.fullscreenElement !== null && !!${cell(0, "label []")}`), "Fullscreen did not reveal typed columns");
      assert.equal(await evaluate(`${cell(0, "big id")}.textContent`), "9007199254740993", "BIGINT display lost precision");
      assert.equal(await evaluate(`${cell(0, "is active?")}.textContent`), "true");
      assert.equal(await evaluate(`${cell(1, "is active?")}.textContent`), "false");
      assert.equal(await evaluate(`${cell(0, "nullable value")}.textContent`), "null");
      assert.equal(await evaluate(`${cell(0, "label []")}.textContent`), "東京");
      await browser("click", '.data-grid .ag-row[row-index="0"] .ag-cell[col-id="order.id"]');
      await ui("press", "--keys", "Control+c");
      await until(async () => await evaluate("typeof window.__gridCopied === 'string'"), "Keyboard copy did not write selected rows");
      const copied = await evaluate("window.__gridCopied") as string;
      assert.equal(copied.split("\n").length, 2, "Keyboard copy should copy only the selected row and header");
      assert.deepEqual(copied.split("\n")[1].split("\t").slice(0, 5), ["1", "9007199254740993", "true", "", "東京"]);
      await click("Export");
      await click("Copy page as Markdown");
      await until(async () => await evaluate("window.__gridCopied.startsWith('| order.id | big id |')"), "Export did not copy visible rows as Markdown");
      const markdown = await evaluate("window.__gridCopied") as string;
      assert(markdown.includes("9007199254740993") && markdown.split("\n").length > 3 && markdown.split("\n").length < 103, "Markdown copy should preserve values and contain only a bounded visible page");
      await click("Exit fullscreen");
      await until(async () => await evaluate("document.fullscreenElement === null"), "Typed-value check did not exit fullscreen");
      const columnsBefore = await evaluate("document.querySelectorAll('.data-grid .ag-header-cell').length");
      assert(columnsBefore > 0 && columnsBefore < 20, "Wide grid should virtualize columns");
      await evaluate("(() => { const viewport = document.querySelector('.data-grid .ag-body-horizontal-scroll-viewport'); viewport.scrollLeft = viewport.scrollWidth; return true; })()");
      await until(async () => await evaluate(`${cell(0, "metric.114")}?.textContent === '114'`), "Horizontal scroll did not render the final column");
      const columnsAfter = await evaluate("document.querySelectorAll('.data-grid .ag-header-cell').length");
      assert(columnsAfter > 0 && columnsAfter < 20, "Column DOM should remain bounded at the right edge");
      await evaluate("(() => { const viewport = document.querySelector('.data-grid .ag-grid-viewport'); viewport.scrollTop = viewport.scrollHeight; return true; })()");
      await until(async () => await evaluate(`${cell(99999, "metric.114")}?.textContent === '100113'`), "Wide grid did not fetch the final row and column");
      const wideRows = await evaluate(`${gridRows}.length`);
      assert(wideRows > 0 && wideRows < 100, "Wide grid should retain bounded row DOM");
      Object.assign(agGrid, { sort: true, search: true, resize: true, emptyAndErrorRecovery: true, rawValues: true, keyboardCopy: true, markdownCopy: true, columnsBefore, columnsAfter, mountedRows: wideRows });
      await ui("screenshot", "--out", logPath + ".data-ag-grid.png");
    } finally {
      await evaluate("window.fetch = window.__gridFetch; Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: window.__gridClipboard }); true");
    }
    // Exercise the real composer -> provider -> MCP -> DuckDB -> viewer path.
    // The loopback provider is scripted; this proves wiring, not model reasoning.
    const manualSql = "SELECT order_id, region, revenue FROM orders ORDER BY order_id LIMIT 8";
    const brokenDraft = "SELECT region, revenue FROM orders WHERE";
    const chatRuns: Array<{ selectedId: string; draft?: string; sql: string }> = [];
    let chatFailure: unknown;
    let chatRequests = 0;
    const upstream = createServer(async (req, res) => {
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "data-chat-fixture" }] }));
        return;
      }
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const request = JSON.parse(raw) as {
          messages: Array<{ role: string; content?: unknown }>;
          tools?: Array<{ function: { name: string } }>;
        };
        chatRequests++;
        const userIndex = request.messages.findLastIndex((message) => message.role === "user");
        const content = request.messages[userIndex]?.content;
        const prompt = typeof content === "string" ? content : JSON.stringify(content);
        const envelope = /<data-context>(.*?)<\/data-context>/.exec(prompt);
        assert(envelope, "Composer did not deliver the selected Data result to the provider");
        const context = JSON.parse(envelope[1]) as { cardId: string; draftSql?: string };
        assert.equal(context.cardId, latest.id, "Chat must target the viewed History result, not the newest result");
        const repair = prompt.includes("Fix the unfinished SQL");
        assert.equal(context.draftSql, repair ? brokenDraft : undefined);
        const nextSql = repair
          ? "SELECT region, revenue FROM orders WHERE region = 'Europe' LIMIT 3"
          : "SELECT order_id, region, revenue FROM orders WHERE region = 'India' ORDER BY order_id LIMIT 5";
        const results = request.messages.slice(userIndex + 1).filter((message) => message.role === "tool").map((message, index) => {
          const tool = index === 0 ? "data_describe" : "data_show";
          assert(typeof message.content === "string", `${tool} returned non-text content`);
          const reply = JSON.parse(message.content) as { ok?: boolean; result?: unknown };
          assert.equal(reply?.ok, true, `${tool} failed: ${message.content.slice(0, 1000)}`);
          assert(typeof reply.result === "string", `${tool} returned no text result`);
          return reply.result;
        });
        const frame = (delta: unknown, finish_reason: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        let response: string;
        if (results.length < 2) {
          const tool = results.length === 0 ? "data_describe" : "data_show";
          const name = request.tools?.find((entry) => entry.function.name.endsWith(tool))?.function.name;
          assert(name, `Provider did not receive ${tool}`);
          if (results.length === 1) {
            assert(results[0].includes(repair ? "region = 'India'" : manualSql), "Data tool did not return the latest saved SQL");
          }
          const args = results.length === 0 ? { id: context.cardId } : { id: context.cardId, sql: nextSql };
          response = frame({ tool_calls: [{ index: 0, id: `data-chat-${chatRuns.length}-${results.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
        } else {
          assert(results[1].includes(context.cardId), "Data update did not return the current result");
          chatRuns.push({ selectedId: context.cardId, draft: context.draftSql, sql: nextSql });
          response = frame({ content: "Updated the current Data result and its SQL query." }, "stop");
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(response + "data: [DONE]\n\n");
      } catch (error) {
        chatFailure = error;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    try {
      const address = upstream.address();
      assert(address && typeof address !== "string");
      await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-data-fixture", url: `http://127.0.0.1:${address.port}/v1`, model: "data-chat-fixture" } });
      await runControlOmb(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "data-chat-fixture", "--url", url]);
      await api("PATCH", `/api/bots/${bot.id}`, { toolScope: { allow: ["mcp:data:data_describe", "mcp:data:data_show"] } });
      await browser("set", "viewport", "1600", "1000");
      await click("Data");
      await until(async () => await evaluate("!!document.querySelector('[data-testid=data-panel] [data-testid=data-history]')"), "Data view did not reopen after configuring the fixture provider");
      await chooseHistory("All 100,000 orders");
      await typeSql(manualSql);
      await until(async () => await evaluate(`${gridCount} === '8'`), "Manual query did not settle before chat");
      const cardsBefore = (await api("GET", DATA_ROUTES.sheet(bot.id))).sheet.cards.length;
      const sendChat = async (text: string, rows: number) => {
        const before = chatRequests;
        await ui("type", "--name", "Message Data review", "--text", text);
        await ui("press", "--keys", "Enter");
        await until(async () => chatRequests > before, "Composer did not send the chat request");
        let settled: any;
        for (let attempt = 0; attempt < 4; attempt++) {
          settled = await runControlOmb(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30", "--url", url]);
          if (chatFailure) throw chatFailure;
          if (settled.status !== "needs-user") break;
          const current = (await api("GET", "/api/bots")).bots.find((entry: { id: string }) => entry.id === bot.id);
          const pending = current.messages.find((message: any) => message.card?.requestId && !message.card.answered)?.card;
          assert(pending, "Fixture approval missing");
          await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.activeTaskId, requestId: pending.requestId, behavior: "allow" });
        }
        assert.equal(settled.status, "settled", JSON.stringify(settled));
        await until(async () => await evaluate(`${gridCount} === '${rows}' && document.querySelector('[role=textbox][aria-label=SQL]')?.textContent === ${JSON.stringify(chatRuns.at(-1)?.sql)} && !document.querySelector('[data-testid=data-panel] [role=alert]')`), "Chat did not update the result and visible SQL or clear the old error");
        assert.equal((await api("GET", DATA_ROUTES.sheet(bot.id))).sheet.cards.length, cardsBefore, "Follow-up should update in place, not add another result");
        assert.equal(await evaluate("document.body.innerText.includes('<data-context>')"), false, "Internal context leaked into the transcript");
      };
      await sendChat("Only show India in this table, keep the same result, and show five rows.", 5);
      assert((await evaluate("new Set([...document.querySelectorAll('[data-testid=sql-editor] .cm-line span')].map(span => getComputedStyle(span).color)).size")) >= 3, "SQL keywords, strings and numbers should be coloured");
      await typeSql(brokenDraft);
      await until(async () => await evaluate("!!document.querySelector('[data-testid=data-panel] [role=alert]')"), "Invalid draft did not produce an error");
      await sendChat("Fix the unfinished SQL I am editing, and show three rows from Europe.", 3);
      assert.equal(chatRuns.length, 2);
      await ui("screenshot", "--out", logPath + ".data-chat.png");
      writeFileSync(logPath + ".data-chat.json", JSON.stringify({ ok: true, provider: "scripted loopback OpenAI-compatible", chatRuns, sameResult: true, visibleSqlUpdated: true }, null, 2) + "\n");
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
    const consoleOutput = await ui("console");
    expectedSqlErrors = await evaluate("window.__sqlErrors");
    const consoleErrors = (consoleOutput.messages ?? []).filter((message: { type: string }) => message.type === "error") as Array<{ text: string }>;
    assert(consoleErrors.length <= expectedSqlErrors, "Unexpected browser errors beyond the deliberate SQL failures");
    assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource: the server responded with a status of (400|404|409|422)/.test(message.text)), []);
    const evidence = logPath + ".data.json";
    const screenshot = logPath + ".data.png";
    await ui("screenshot", "--out", screenshot);
    writeFileSync(evidence, JSON.stringify({ ok: true, rows: 100_000, historyCards: 20, initialDomRows: initialRows, finalDomRows: finalRows, activeResults: 1, restart: true, inlineReceipt: true, recordedSqlReceipt: true, closedPanelReceipt: true, consumedReceipt: true, history: true, chartTableToggle: true, layout: { normal: normalLayout, fullscreen: fullscreenLayout, chart: chartLayout, chartFullscreen, tableFooter, chartFooter, restored: true, chartEditSqlTop: chartEditLayout, validationEditSqlBounds: validationEditLayout }, resizing, agGrid, liveResult: true, liveSql: { invalidPreservesResult: true, keystrokeUpdates: true, newestWins: true, chartPreserved: true, chartRemainsVisible: true, expectedHttp400: expectedSqlErrors }, console: consoleOutput, screenshots: [logPath + ".data-recorded-sql.png", logPath + ".data-grid.png", logPath + ".data-fullscreen.png", logPath + ".data-chart.png", logPath + ".data-chart-fullscreen.png", logPath + ".data-live-sql.png", ...resizeScreenshots, logPath + ".data-ag-grid.png", screenshot], logPath }, null, 2) + "\n");
    console.log(JSON.stringify({ ok: true, evidence, screenshot }));
  }
} catch (error) {
  if (handle) {
    const diagnostics = await Promise.all([
      agentBrowser(handle.binary, sessionEnv(handle), ["eval", "({ clipboardPrefix: window.__gridCopied?.slice(0,300), alerts: [...document.querySelectorAll('[role=alert]')].map(element=>element.textContent), selectedRows: document.querySelectorAll('.ag-row[aria-selected=true]').length, renderedRows: document.querySelectorAll('.ag-row[row-index]').length })"]),
      agentBrowser(handle.binary, sessionEnv(handle), ["console"]),
    ]).catch(() => null);
    if (diagnostics) writeFileSync(logPath + ".data-failed.json", JSON.stringify(diagnostics, null, 2) + "\n");
    await agentBrowser(handle.binary, sessionEnv(handle), ["screenshot", logPath + ".data-failed.png"])
      .then(() => console.error(`Data fixture failure evidence: ${logPath}.data-failed.png`), () => {});
  }
  throw error;
} finally {
  if (handle) await closeBrowserSession(handle.binary, sessionEnv(handle));
  await preview?.close();
  await waitForExit(server, { signal: "SIGTERM" });
  await fixture.close();
}
