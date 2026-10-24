import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "../scripts/testing/control-omb-ui.ts";

it.skipIf(process.env.OMB_UI_E2E !== "1")("real production ChatView exposes delegated current status through normal thread navigation", async () => {
 const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true }, [], undefined, resolve(process.env.OFFICE_FIXTURE_DIST ?? "dist"));
 const dir = resolve(process.env.OFFICE_EVIDENCE_DIR ?? ".omb-scratch/full-app"); mkdirSync(dir, { recursive: true });
 const evidence: unknown[] = []; let browser: { binary: string; env: NodeJS.ProcessEnv } | undefined;
 const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any; evidence.push({ method, path, status: response.status, result });
  expect(response.ok).toBe(true); return result;
 };
 const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
 try {
  await api("PATCH", "/api/config", { features: { showToolCalls: true } });
  const fakeSource = resolve("server/testing/fake-claude-cli.ts");
  const fakeCli = join(fixture.info.dataDir, "full-thread-fake-cli.ts");
  const source = readFileSync(fakeSource, "utf8").replaceAll('"./launch-note.ts"', JSON.stringify(resolve("server/testing/launch-note.ts")))
   .replaceAll('"./room-handoff-agent.ts"', JSON.stringify(resolve("server/testing/room-handoff-agent.ts")))
   .replace('const progress = (text: string) => out({ type: "assistant", message: { content: [{ type: "text", text }] } });',
    'const progress = (text: string) => text === "FULL_THREAD_PENDING_TOOL" ? out({ type: "assistant", message: { content: [{ type: "tool_use", id: `pending-${process.pid}`, name: "Bash", input: { command: "npm run fixture-build" } }] } }) : out({ type: "assistant", message: { content: [{ type: "text", text }] } });');
  writeFileSync(fakeCli, source); chmodSync(fakeCli, 0o700);
  await api("PATCH", "/api/instances/claude", { cli: fakeCli });
  const chief = (await cli("new-bot", "--name", "Full Thread Chief", "--section", "Leadership")).bot;
  const expert = (await cli("new-bot", "--name", "Full Thread Engineer", "--section", "Engineering")).bot;
  await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true });
  const defaultBot = (await api("GET", "/api/bots?messages=0")).bots.find((b: { defaultBot?: unknown; id: string }) => Boolean(b.defaultBot));
  if (defaultBot) await api("PATCH", `/api/bots/${defaultBot.id}`, { welcomed: true });
  const plan: Record<string, unknown> = {
   [chief.id]: { steps: [{ arguments: { bot_ids: [expert.id], message: "Bounded full thread fixture work" } }], reply: "Assigned" },
   [expert.id]: { progress: "FULL_THREAD_PENDING_TOOL", gateFile: join(fixture.info.dataDir, "expert-gate"), reply: "Partial report" },
  };
  writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
  await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Delegate the full thread fixture");
  await expect.poll(() => readHandoffs(fixture.info.dataDir).some(row => row.parentId && row.status === "running"), { timeout: 20000 }).toBe(true);
  const child = readHandoffs(fixture.info.dataDir).find(row => row.parentId && row.status === "running")!;
  const root = readHandoffs(fixture.info.dataDir).find(row => row.id === child.rootId)!;
  const tools = await ensureUiBrowser(process.env);
  browser = { binary: tools.binary, env: sessionEnv({ home: fixture.info.dataDir, session: `ft-${process.pid}`, chrome: tools.chrome }) };
  browser.env.AGENT_BROWSER_SOCKET_DIR = "/tmp";
  browser.env.AGENT_BROWSER_ARGS = `${browser.env.AGENT_BROWSER_ARGS ?? ""}\n--no-sandbox`;
  const command = (...args: string[]) => agentBrowser(browser!.binary, browser!.env, args, 60000);
  const evaluate = async (js: string) => (await command("eval", js)).result;
  const capture = async (name: string) => {
   await command("screenshot", join(dir, `${name}.png`));
   writeFileSync(join(dir, `${name}.dom.json`), JSON.stringify(await evaluate(`({url:location.href,text:document.body.innerText,html:document.documentElement.outerHTML})`), null, 2));
   evidence.push({ capture: name, console: await command("console") });
  };
  await command("set", "viewport", "1440", "1000"); await command("open", fixture.info.url);
  await evaluate(`localStorage.setItem('omb-analytics-opt-out','1');localStorage.setItem('omb-email-gate','skipped');localStorage.setItem('omb-advanced-mode','1');true`);
  await command("reload");
  const click = async (selector: string) => {
   await expect.poll(() => evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});e?.click();return !!e})()`), { timeout: 30000 }).toBe(true);
  };
  await click(`[data-sidebar-bot-row="${chief.id}"]`);
  const delegatedSelector = `[data-thread-link="${child.threadId}"], [data-thread-chip="${child.threadId}"], [data-sidebar-thread-row="${child.threadId}"], [data-sidebar-activity-row="${child.threadId}"]`;
  await click(delegatedSelector);
  await api("GET", `/api/threads/${child.threadId}/messages?limit=100`);
  await capture("delegated-live-before-assert");
  await expect.poll(() => evaluate(`!!document.querySelector('[data-testid="tool-activity"] .animate-status-pulse')`), { timeout: 15000 }).toBe(true);
  await capture("delegated-genuinely-live-tool");
  await click(`[data-sidebar-bot-row="${chief.id}"]`);
  const base = `/api/bots/${chief.id}/jobs/${root.id}`;
  const snapshot = await api("GET", `${base}/cancellation`);
  expect((await api("POST", `${base}/cancel`, snapshot)).state).toBe("cancelled");
  await expect.poll(() => readHandoffs(fixture.info.dataDir).find(row => row.id === child.id)?.status, { timeout: 15000 }).toBe("cancelled");
  const delegated = await api("GET", `/api/threads/${child.threadId}/job?since=0`);
  expect(delegated.current.status).toBe("cancelled");
  await capture("chief-cancelled");
  await click(delegatedSelector);
  await capture("delegated-before-assert");
  const footer = () => evaluate(`document.querySelector('[data-current-job-id]')?.textContent`);
  await expect.poll(footer, { timeout: 10000 }).toBe("Job cancelled. Partial reports are retained.");
  expect(await evaluate(`Array.from(document.querySelectorAll('button')).some(b=>/^Cancel:|^Cancel job/.test(b.textContent.trim()))`)).toBe(false);
  const cancelledMessages = await api("GET", `/api/threads/${child.threadId}/messages?limit=100`);
  expect(cancelledMessages.messages.some((m: any) => m.tool?.name === "Bash" && m.tool.ok === undefined)).toBe(true);
  expect(await evaluate(`document.querySelector('[data-testid="tool-activity"]')?.textContent.includes('Result/status unrecorded and unverified.')`)).toBe(true);
  expect(await evaluate(`!!document.querySelector('[data-testid="tool-activity"] .animate-status-pulse')`)).toBe(false);
  await capture("delegated-cancelled"); await command("reload");
  await expect.poll(footer, { timeout: 30000 }).toBe("Job cancelled. Partial reports are retained.");
  await capture("delegated-cancelled-reloaded");
  plan[expert.id] = { reply: 'Fixture blocked\n\nOPENMAUS_TASK_RESULT: {"state":"blocked","reason":"Fixture tool missing"}' };
  writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
  await cli("send", "--bot", expert.id, "--task", child.threadId, "--text", "Record the bounded fixture blocker");
  await cli("wait", "--bot", expert.id, "--task", child.threadId, "--timeout", "15");
  await command("reload"); await expect.poll(footer, { timeout: 30000 }).toBe("Job blocked: Fixture tool missing"); await capture("delegated-blocked");
  plan[expert.id] = { reply: 'Fixture complete\n\nOPENMAUS_TASK_RESULT: {"state":"completed"}' };
  writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
  await cli("send", "--bot", expert.id, "--task", child.threadId, "--text", "Complete the newer bounded fixture request");
  await cli("wait", "--bot", expert.id, "--task", child.threadId, "--timeout", "15");
  await command("reload"); await expect.poll(footer, { timeout: 30000 }).toBe("Job completed."); await capture("delegated-newer-completed");
  expect(await evaluate(`Array.from(document.querySelectorAll('button')).some(b=>/^Cancel:|^Cancel job/.test(b.textContent.trim()))`)).toBe(false);
  const inspect = async () => {
   await click('[data-testid="chat-more"]');
   await command("find", "text", "Inspector", "click", "--exact");
   await expect.poll(() => evaluate(`document.querySelector('aside[aria-label="Inspector"]')?.textContent`), { timeout: 15000 }).toContain("Result/status unrecorded and unverified.");
   expect(await evaluate(`!!document.querySelector('aside[aria-label="Inspector"] .animate-spin')`)).toBe(false);
  };
  await inspect(); await capture("historical-inspector-unverified");
  await command("find", "role", "button", "click", "--name", "Close the Inspector", "--exact");
  plan[expert.id] = { progress: "FULL_THREAD_PENDING_TOOL", gateFile: join(fixture.info.dataDir, "new-live-gate"), reply: 'Live fixture done\n\nOPENMAUS_TASK_RESULT: {"state":"completed"}' };
  writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
  await cli("send", "--bot", expert.id, "--task", child.threadId, "--text", "Keep a newer fixture tool genuinely live");
  await expect.poll(() => evaluate(`Array.from(document.querySelectorAll('[data-testid="tool-activity"]')).filter(e=>e.querySelector('.animate-status-pulse')).length`), { timeout: 15000 }).toBe(1);
  await click('[data-testid="chat-more"]'); await command("find", "text", "Inspector", "click", "--exact");
  await api("GET", `/api/threads/${child.threadId}/messages?limit=100`);
  await api("GET", "/api/bots?messages=0");
  await capture("new-live-inspector-before-assert");
  await expect.poll(() => evaluate(`document.querySelectorAll('aside[aria-label="Inspector"] .animate-spin').length`), { timeout: 15000 }).toBe(1);
  expect(await evaluate(`document.querySelector('aside[aria-label="Inspector"]')?.textContent`)).toContain("Result/status unrecorded and unverified.");
  await capture("historical-plus-new-live-tool");
  await command("network", "route", "**/api/auth/session", "--body", JSON.stringify({ kind: "session", id: "fixture-readonly", label: "Fixture read-only viewer", scopes: ["client"], expiresAt: Date.now() + 60000, cloudGuest: true, openedThreads: [] }));
  await command("reload");
  await expect.poll(() => evaluate(`document.querySelector('[data-current-job-id]')?.textContent`), { timeout: 30000 }).toBe("Job running.");
  evidence.push({ readonlySession: await evaluate(`fetch("/api/auth/session").then(r=>r.json())`) });
  await capture("readonly-before-assert");
  await expect.poll(() => evaluate(`Array.from(document.querySelectorAll('button')).some(b=>/^Cancel:|^Cancel job/.test(b.textContent.trim())||b.title==='Stop this turn')`), { timeout: 10000 }).toBe(false);
  expect(await evaluate(`!!document.querySelector('textarea')`)).toBe(false);
  await capture("readonly-status-actions-hidden");
  writeFileSync(join(fixture.info.dataDir, "new-live-gate"), "finish");
  await cli("wait", "--bot", expert.id, "--task", child.threadId, "--timeout", "15");
  const consoleResult = await command("console"); evidence.push({ consoleResult });
  expect(((consoleResult.messages ?? []) as Array<{ type: string }>).filter(m => m.type === "error")).toEqual([]);
 } finally {
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ fixture: fixture.info, evidence }, null, 2));
  if (browser) await agentBrowser(browser.binary, browser.env, ["close"]).catch(() => {});
  await fixture.close();
 }
}, 240000);
