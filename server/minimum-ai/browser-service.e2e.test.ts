import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserService } from "../browser/service.ts";
import { CHROME_ENGINE, RuntimeRouter, type ChromeEngine } from "../browser/engines.ts";
import type { BrowserRuntime } from "../browser-runtime.ts";
import { createBrowserRecording } from "./browser-replay.ts";
import { browserWorkflowCatalog, browserWorkflowFromRecording, browserWorkflowInvoker } from "./browser-workflow.ts";
import { schemaCheckedInvoker } from "./schema-check.ts";
import { executeWorkflow } from "./workflow.ts";
import { createRecordingTurns } from "./recording-turn.ts";
import { FakeBackend } from "../browser/testing/fake-chrome.ts";
import { FixtureServer } from "../browser/cdp/testing/fixtures.ts";
import { CHROME, startChrome, type RunningChrome } from "../browser/cdp/testing/real-chrome.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { hostTimeout } from "../testing/host-timeout.ts";

(CHROME ? describe : describe.skip)("saved browser action through the browser service", () => {
  let fx: FixtureServer, chrome: RunningChrome, service: BrowserService, dir: string;
  const target = { session: "sample", key: "bot:sample" };
  beforeAll(async () => {
    fx = await FixtureServer.start();
    chrome = await startChrome("minimum-ai-browser-service");
    dir = mkdtempSync(join(tmpdir(), "omb-minimum-ai-service-"));
    const caps = new FakeBackend().caps;
    service = new BrowserService({ dataDir: dir, backend: () => ({ kind: "local", caps, open: async () => ({ browser: chrome.browser, pid: null, version: "153.0.0.0", exited: chrome.chrome.exited.then(() => undefined), close: () => chrome.close() }) }), maxRunning: 2, idleMs: () => 600_000 });
  }, hostTimeout(180_000));
  afterAll(async () => { await service?.closeAll(); await fx?.close(); if (dir) await removeTempDir(dir); });
  it("checks caller access and the exact page before clicking a unique button", async () => {
    const url = fx.page("/service-sample", '<!doctype html><button onclick="this.textContent=\'Done\'">Run sample</button>');
    const call = (name: string, args: object) => service.agentRpc(target, "tools/call", { name, arguments: args });
    const opened = await call("agent_browser_open", { url });
    expect(opened).not.toHaveProperty("isError", true);
    const step = { origin: new URL(url).origin, url, role: "button", name: "Run sample" };
    await expect(service.replayClick(target, { ...step, url: `${url}?different=1` }, new AbortController().signal, () => {})).rejects.toThrow(/different page/);
    let count = 0;
    await expect(service.replayClick(target, step, new AbortController().signal, () => { if (++count === 2) throw new Error("access revoked"); })).rejects.toThrow(/access revoked/);
    let allowed = false;
    const router = new RuntimeRouter({} as BrowserRuntime, { service } as ChromeEngine, { afterClaim: () => allowed ? null : "browser ownership refused" });
    const spec = { command: CHROME_ENGINE, args: [target.key], env: {} };
    await expect(router.replayClick(target.session, spec, step, new AbortController().signal, () => {})).rejects.toThrow("browser ownership refused");
    allowed = true;
    const snapshot = await call("agent_browser_snapshot", {});
    const ref = JSON.stringify(snapshot).replaceAll('\\"', '"').match(/button "Run sample" \[ref=(e\d+)\]/)?.[1];
    expect(ref).toBeTruthy();
    const recording = createBrowserRecording();
    const context = { botId: "sample", botName: "Sample", threadId: "sample-thread", generation: "sample-turn", turnId: () => null, record: false, minimumAiRecording: recording };
    const first = await router.agentRpc(target.session, spec, "tools/call", { name: "agent_browser_click", arguments: { ref } }, () => {}, context);
    expect(first).not.toHaveProperty("isError", true);
    const recorded = recording.finish();
    expect(recorded).toMatchObject([step]);
    await call("agent_browser_open", { url });
    const saved = recorded[0]!;
    if ("kind" in saved) throw new Error("Expected a captured click");
    await router.replayClick(target.session, spec, saved, new AbortController().signal, () => {});
    const read = await call("agent_browser_read", {});
    expect(JSON.stringify(read)).toContain("Done");
  }, hostTimeout(60_000));
  it("records a bot opening a page and clicking, then replays both steps", async () => {
    const url = fx.page("/record-sequence", '<!doctype html><button onclick="this.textContent=\'Finished\'">Execute sample</button>');
    const router = new RuntimeRouter({} as BrowserRuntime, { service } as ChromeEngine);
    const spec = { command: CHROME_ENGINE, args: [target.key], env: {} };
    const turns = createRecordingTurns(), run = turns.begin("sample-thread", "sample");
    const context = () => ({ botId: "sample", botName: "Sample", threadId: "sample-thread", generation: "sample-turn", turnId: () => null, record: false, minimumAiRecording: turns.browserCall("sample-thread", "sample", "sample-turn") });
    turns.started("sample-thread", "open-1", "mcp__browser__agent_browser_open");
    const first = await router.agentRpc(target.session, spec, "tools/call", { name: "agent_browser_open", arguments: { url } }, () => {}, context());
    turns.completed("sample-thread", "open-1", true);
    const ref = JSON.stringify(first).replaceAll('\\"', '"').match(/button "Execute sample" \[ref=(e\d+)\]/)?.[1];
    expect(ref).toBeTruthy();
    turns.started("sample-thread", "click-1", "mcp__browser__agent_browser_click");
    await router.agentRpc(target.session, spec, "tools/call", { name: "agent_browser_click", arguments: { ref } }, () => {}, context());
    turns.completed("sample-thread", "click-1", true);
    const steps = run.finish(true);
    expect(steps).toHaveLength(2);
    await service.agentRpc(target, "tools/call", { name: "agent_browser_open", arguments: { url: fx.page("/other-sample", "<p>Other sample</p>") } });
    const invoke = schemaCheckedInvoker(browserWorkflowCatalog, browserWorkflowInvoker((step, signal) => "kind" in step && step.kind === "list" ? router.listTargets(target.session, spec, step, signal, () => {}) : router.replaySteps(target.session, spec, [step], signal, () => {})));
    const result = await executeWorkflow(browserWorkflowFromRecording(steps), invoke);
    expect(result.status).toBe("completed");
    const read = await service.agentRpc(target, "tools/call", { name: "agent_browser_read", arguments: {} });
    expect(JSON.stringify(read)).toContain("Finished");
  }, hostTimeout(60_000));
  it("uses fresh page targets to repeat a simple action on matching items", async () => {
    const url = fx.page("/dynamic-sample", '<!doctype html><button onclick="this.textContent=\'Done Alpha\'">Delete trash: Alpha</button><button onclick="this.textContent=\'Done Gamma\'">Delete trash: Gamma</button><button>Keep Beta</button>');
    const origin = new URL(url).origin;
    const router = new RuntimeRouter({} as BrowserRuntime, { service } as ChromeEngine);
    const spec = { command: CHROME_ENGINE, args: [target.key], env: {} };
    const invoke = schemaCheckedInvoker(browserWorkflowCatalog, browserWorkflowInvoker((step, signal) => "kind" in step && step.kind === "list" ? router.listTargets(target.session, spec, step, signal, () => {}) : router.replaySteps(target.session, spec, [step], signal, () => {})));
    const { parseWorkflow } = await import("./workflow.ts");
    const plan = parseWorkflow({ version: 1, steps: [
      { kind: "call", id: "open", tool: "MINAI_BROWSER_OPEN", input: { url } },
      { kind: "call", id: "list", tool: "MINAI_BROWSER_LIST", input: { origin, url, role: "button", prefix: "Delete trash: " } },
      { kind: "each", id: "each", from: "list.items", steps: [{ kind: "call", id: "click", tool: "MINAI_BROWSER_CLICK", input: { origin: { $ref: "item.origin" }, url: { $ref: "item.url" }, role: { $ref: "item.role" }, name: { $ref: "item.name" } } }] },
    ] });
    expect((await executeWorkflow(plan, invoke)).status).toBe("completed");
    const read = JSON.stringify(await service.agentRpc(target, "tools/call", { name: "agent_browser_read", arguments: {} }));
    expect(read).toContain("Done Alpha"); expect(read).toContain("Done Gamma"); expect(read).toContain("Keep Beta");
  }, hostTimeout(60_000));
  it("records and replays a form fill and refuses a field that changed to a password", async () => {
    const url = fx.page("/fill-sample", '<!doctype html><input type="text" aria-label="Name">');
    const router = new RuntimeRouter({} as BrowserRuntime, { service } as ChromeEngine);
    const spec = { command: CHROME_ENGINE, args: [target.key], env: {} };
    const opened = await service.agentRpc(target, "tools/call", { name: "agent_browser_open", arguments: { url } });
    const ref = JSON.stringify(opened).replaceAll('\\"', '"').match(/textbox "Name" \[ref=(e\d+)\]/)?.[1];
    expect(ref).toBeTruthy();
    const recording = createBrowserRecording();
    const context = { botId: "sample", botName: "Sample", threadId: "sample-thread", generation: "sample-turn", turnId: () => null, record: false, minimumAiRecording: recording };
    const first = await router.agentRpc(target.session, spec, "tools/call", { name: "agent_browser_fill", arguments: { ref, text: "Ada" } }, () => {}, context);
    expect(first).not.toHaveProperty("isError", true);
    const steps = recording.finish();
    await service.agentRpc(target, "tools/call", { name: "agent_browser_open", arguments: { url } });
    await router.replaySteps(target.session, spec, steps, new AbortController().signal, () => {});
    expect(JSON.stringify(await service.agentRpc(target, "tools/call", { name: "agent_browser_snapshot", arguments: {} }))).toContain("Ada");
    fx.page("/fill-sample", '<!doctype html><input type="password" aria-label="Name">');
    await service.agentRpc(target, "tools/call", { name: "agent_browser_open", arguments: { url } });
    await expect(router.replaySteps(target.session, spec, steps, new AbortController().signal, () => {})).rejects.toThrow(/sensitive|unsupported|target/i);
  }, hostTimeout(60_000));
});
