import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-omb.ts";
import { startFakeConnectedApps } from "../testing/fake-connected-apps.ts";

it("learns a paginated cleanup of changing sample records and later replays without AI", async () => {
  const apps = await startFakeConnectedApps();
  apps.workflowSchemas = true; apps.workflowNotion = true; apps.connected.notion = true;
  apps.notionRecords = [{ id: "alpha", group: "Trash" }, { id: "beta", group: "Inbox" }, { id: "gamma", group: "Trash" }];
  const plan = { version: 1, steps: [
    { kind: "call", id: "query", tool: "NOTION_QUERY_DATABASE", input: { database_id: "sample" }, pagination: { cursorArg: "start_cursor", nextPath: "next_cursor", itemsPath: "results", hasMorePath: "has_more", maxPages: 5 } },
    { kind: "each", id: "trash", from: "query.results", where: { path: "item.group", equals: "Trash" }, steps: [{ kind: "call", id: "move", tool: "NOTION_DELETE_BLOCK", input: { block_id: { $ref: "item.id" } } }] },
  ] };
  const fixture = await launchVerificationServer({ ...process.env, OMB_MINIMUM_AI_EXPERIMENT: "1", OMB_COMPOSIO_BROKER_URL: apps.url, OMB_COMPOSIO_BROKER_TOKEN: apps.token, FAKE_CLAUDE_TEXT_RESULT: JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(plan) }) });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
    return result;
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Cleanup fixture" })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { composio: true, connectorScopes: { apps: { notion: "write" } } });
    const routine = (await api("POST", "/api/routines", { name: "Trash cleanup", prompt: "Move all Trash records to trash", botId: bot.id, target: "bot", runOn: "maus", schedule: { type: "once", at: Date.now() + 60_000 }, executionMode: "minimum-ai", enabled: false })).routine;
    const base = `/api/routines/${routine.id}/minimum-ai`;
    const draft = (await api("POST", `${base}/prepare`, {})).workflow;
    const result = (await api("POST", `${base}/test`, { fingerprint: draft.fingerprint })).result;
    expect(result.status).toBe("completed");
    expect(apps.notionRecords).toEqual([{ id: "beta", group: "Inbox" }]);
    expect(apps.calls.filter((call) => call.tool === "NOTION_DELETE_BLOCK").map((call) => (call.arguments as { block_id: string }).block_id)).toEqual(["alpha", "gamma"]);
    await api("POST", `${base}/approve`, { fingerprint: draft.fingerprint });
    const searches = apps.calls.filter((call) => call.tool === "COMPOSIO_SEARCH_TOOLS").length;
    apps.notionRecords.push({ id: "delta", group: "Trash" });
    const run = (await api("POST", `/api/routines/${routine.id}/run`, {})).run;
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((item: { id: string }) => item.id === run.id)?.status, { timeout: 15_000 }).toBe("completed");
    expect(apps.notionRecords).toEqual([{ id: "beta", group: "Inbox" }]);
    expect(apps.calls.filter((call) => call.tool === "NOTION_DELETE_BLOCK").map((call) => (call.arguments as { block_id: string }).block_id)).toEqual(["alpha", "gamma", "delta"]);
    expect(apps.calls.filter((call) => call.tool === "COMPOSIO_SEARCH_TOOLS")).toHaveLength(searches);
    const noMatch = (await api("POST", `/api/routines/${routine.id}/run`, {})).run;
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((item: { id: string }) => item.id === noMatch.id)?.status, { timeout: 15_000 }).toBe("completed");
    expect(apps.calls.filter((call) => call.tool === "NOTION_DELETE_BLOCK")).toHaveLength(3);
  } finally { await fixture.close(); await apps.close(); }
}, 120_000);
