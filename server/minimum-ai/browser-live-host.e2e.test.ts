import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-omb.ts";
import { CHROME } from "../browser/cdp/testing/real-chrome.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("does not approve a real first bot run when its tools were not recorded", async () => {
  const fixture = await launchVerificationServer({ ...process.env, OMB_MINIMUM_AI_EXPERIMENT: "1" });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true }, browserEngine: { engine: "chrome" } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Sample recording bot" })).body.bot;
    const routine = (await api("POST", "/api/routines", { name: "Sample", prompt: "Do a sample task", botId: bot.id, target: "bot", runOn: "maus", schedule: { type: "once", at: Date.now() + 60_000 }, executionMode: "minimum-ai", enabled: false })).body.routine;
    const base = `/api/routines/${routine.id}/minimum-ai`;
    expect((await api("POST", `${base}/record`, {})).status).toBe(400);
    const response = await api("POST", `${base}/record`, { confirm: true });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/incomplete|record/i);
    expect((await api("GET", `${base}/recovery`)).body.interrupted).toBe(true);
    expect((await api("POST", `${base}/acknowledge`, { confirm: true })).body.interrupted).toBe(false);
  } finally { await fixture.close(); }
}, 90_000);

it.skipIf(!CHROME)("records a real bot browser run and replays the approved workflow through the scheduler", async () => {
  const { FixtureServer } = await import("../browser/cdp/testing/fixtures.ts");
  const page = await FixtureServer.start();
  const folder = mkdtempSync(join(tmpdir(), "omb-browser-turn-count-"));
  const turnState = join(folder, "turn-count");
  const url = page.page("/sample", '<!doctype html><button onclick="this.textContent=\'Done\'">Run sample</button>');
  const calls = [{ name: "agent_browser_open", server: "browser", input: { url } }, { name: "agent_browser_click", server: "browser", input: { ref: "e1" } }];
  const fixture = await launchVerificationServer({ ...process.env, OMB_MINIMUM_AI_EXPERIMENT: "1", FAKE_CLAUDE_TOOL_CALLS: JSON.stringify(calls), FAKE_CLAUDE_TURN_STATE: turnState });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const configured = await api("PATCH", "/api/config", { features: { browser: true }, browserEngine: { engine: "chrome", egress: { localNetwork: true } } });
    expect(configured.status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Sample browser bot" })).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "auto", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    const routine = (await api("POST", "/api/routines", { name: "Sample", prompt: "Open the sample page and click Run sample", botId: bot.id, target: "bot", runOn: "maus", schedule: { type: "once", at: Date.now() + 60_000 }, executionMode: "minimum-ai", enabled: false })).body.routine;
    const base = `/api/routines/${routine.id}/minimum-ai`;
    const recorded = await api("POST", `${base}/record`, { confirm: true });
    expect(recorded, JSON.stringify(recorded.body)).toMatchObject({ status: 200, body: { workflow: { verified: true, approved: false } } });
    expect((await api("POST", `${base}/approve`, { fingerprint: recorded.body.workflow.fingerprint })).status).toBe(200);
    const modelTurns = readFileSync(turnState, "utf8");
    const before = page.requests.length;
    const run = (await api("POST", `/api/routines/${routine.id}/run`, {})).body.run;
    await expect.poll(async () => (await api("GET", "/api/routines")).body.runs.find((item: { id: string }) => item.id === run.id), { timeout: 20_000 }).toMatchObject({ status: "completed" });
    expect(page.requests.length).toBeGreaterThan(before);
    expect(readFileSync(turnState, "utf8")).toBe(modelTurns);
    page.page("/sample", "<!doctype html><p>The sample button is missing</p>");
    const failed = (await api("POST", `/api/routines/${routine.id}/run`, {})).body.run;
    await expect.poll(async () => (await api("GET", "/api/routines")).body.runs.find((item: { id: string }) => item.id === failed.id), { timeout: 20_000 }).toMatchObject({ status: "failed", partial: true });
    expect((await api("GET", `${base}/recovery`)).body.interrupted).toBe(true);
    expect(readFileSync(turnState, "utf8")).toBe(modelTurns);
  } finally { await fixture.close(); await page.close(); rmSync(folder, { recursive: true, force: true }); }
}, 120_000);

it.skipIf(!CHROME)("learns a changing-item browser pattern from the first run and reuses it without AI", async () => {
  const { FixtureServer } = await import("../browser/cdp/testing/fixtures.ts");
  const page = await FixtureServer.start();
  const folder = mkdtempSync(join(tmpdir(), "omb-browser-learning-"));
  const modelLog = join(folder, "model.log");
  const html = (one: string, two: string) => `<!doctype html><button onclick="this.textContent='Done ${one}'">Trash: ${one}</button><button onclick="this.textContent='Done ${two}'">Trash: ${two}</button><button>Keep Beta</button>`;
  const url = page.page("/dynamic", html("Alpha", "Gamma")), origin = new URL(url).origin;
  const calls = [{ name: "agent_browser_open", server: "browser", input: { url } }, { name: "agent_browser_click", server: "browser", input: { ref: "e1" } }, { name: "agent_browser_click", server: "browser", input: { ref: "e2" } }];
  const plan = { version: 1, steps: [
    { kind: "call", id: "open", tool: "MINAI_BROWSER_OPEN", input: { url } },
    { kind: "call", id: "list", tool: "MINAI_BROWSER_LIST", input: { origin, url, role: "button", prefix: "Trash: " } },
    { kind: "each", id: "each", from: "list.items", steps: [{ kind: "call", id: "click", tool: "MINAI_BROWSER_CLICK", input: { origin: { $ref: "item.origin" }, url: { $ref: "item.url" }, role: { $ref: "item.role" }, name: { $ref: "item.name" } } }] },
  ] };
  const fixture = await launchVerificationServer({ ...process.env, OMB_MINIMUM_AI_EXPERIMENT: "1", FAKE_CLAUDE_TOOL_CALLS: JSON.stringify(calls), FAKE_CLAUDE_TEXT_LOG: modelLog, FAKE_CLAUDE_TEXT_RESULT: JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(plan) }) });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true }, browserEngine: { engine: "chrome", egress: { localNetwork: true } } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Dynamic browser bot" })).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "auto", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    const routine = (await api("POST", "/api/routines", { name: "Sample", prompt: "Click each Trash item", botId: bot.id, target: "bot", runOn: "maus", schedule: { type: "once", at: Date.now() + 60_000 }, executionMode: "minimum-ai", enabled: false })).body.routine;
    const base = `/api/routines/${routine.id}/minimum-ai`;
    const recorded = await api("POST", `${base}/record`, { confirm: true });
    expect(recorded, JSON.stringify(recorded.body)).toMatchObject({ status: 200, body: { workflow: { verified: true, approved: false, plan: { steps: [{ tool: "MINAI_BROWSER_OPEN" }, { tool: "MINAI_BROWSER_LIST" }, { kind: "each" }] } } } });
    expect((await api("POST", `${base}/approve`, { fingerprint: recorded.body.workflow.fingerprint })).status).toBe(200);
    const modelCalls = readFileSync(modelLog, "utf8").trim().split("\n").length;
    page.page("/dynamic", html("Delta", "Epsilon"));
    const run = (await api("POST", `/api/routines/${routine.id}/run`, {})).body.run;
    await expect.poll(async () => (await api("GET", "/api/routines")).body.runs.find((item: { id: string }) => item.id === run.id), { timeout: 20_000 }).toMatchObject({ status: "completed", output: "Completed 4 browser steps." });
    expect(readFileSync(modelLog, "utf8").trim().split("\n")).toHaveLength(modelCalls);
  } finally { await fixture.close(); await page.close(); rmSync(folder, { recursive: true, force: true }); }
}, 120_000);

it.skipIf(!CHROME)("records and replays a non-secret form through the app", async () => {
  const { FixtureServer } = await import("../browser/cdp/testing/fixtures.ts");
  const page = await FixtureServer.start(), received: string[] = [];
  const url = page.page("/form", '<!doctype html><form action="/submit"><input type="text" name="name" aria-label="Name"><button>Submit sample</button></form>');
  page.route("/submit", (_request, parsed) => { received.push(parsed.searchParams.get("name") ?? ""); return { body: "<!doctype html><p>Sample submitted</p>" }; });
  const calls = [{ name: "agent_browser_open", server: "browser", input: { url } }, { name: "agent_browser_fill", server: "browser", input: { ref: "e1", text: "Ada" } }, { name: "agent_browser_click", server: "browser", input: { ref: "e2" } }];
  const fixture = await launchVerificationServer({ ...process.env, OMB_MINIMUM_AI_EXPERIMENT: "1", FAKE_CLAUDE_TOOL_CALLS: JSON.stringify(calls) });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true }, browserEngine: { engine: "chrome", egress: { localNetwork: true } } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Form bot" })).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "auto", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    const routine = (await api("POST", "/api/routines", { name: "Sample form", prompt: "Fill Name with Ada and submit the sample form", botId: bot.id, target: "bot", runOn: "maus", schedule: { type: "once", at: Date.now() + 60_000 }, executionMode: "minimum-ai", enabled: false })).body.routine;
    const base = `/api/routines/${routine.id}/minimum-ai`;
    const recorded = await api("POST", `${base}/record`, { confirm: true });
    expect(recorded, JSON.stringify(recorded.body)).toMatchObject({ status: 200, body: { workflow: { verified: true, approved: false } } });
    expect(recorded.body.workflow.plan.steps.map((step: { tool: string }) => step.tool)).toEqual(["MINAI_BROWSER_OPEN", "MINAI_BROWSER_FILL", "MINAI_BROWSER_CLICK"]);
    expect(received).toEqual(["Ada"]);
    expect((await api("POST", `${base}/approve`, { fingerprint: recorded.body.workflow.fingerprint })).status).toBe(200);
    const run = (await api("POST", `/api/routines/${routine.id}/run`, {})).body.run;
    await expect.poll(async () => (await api("GET", "/api/routines")).body.runs.find((item: { id: string }) => item.id === run.id), { timeout: 20_000 }).toMatchObject({ status: "completed" });
    expect(received).toEqual(["Ada", "Ada"]);
  } finally { await fixture.close(); await page.close(); }
}, 120_000);
