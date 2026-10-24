import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "../scripts/testing/control-omb-ui.ts";
import { TASK_RESULT_PROMPT } from "./task-disposition.ts";
import { mountPreview, type MountedPreview } from "../scripts/testing/preview-fixture.ts";

it("paired Chief cancellation stops the exact native job after ordinary Stop left a running hand-off", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [];
  const assertProducerPrompt = async (path: string, contains: string) => {
    await expect.poll(() => JSON.stringify(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).prompt), { timeout: 15_000 }).toContain(contains);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(dump.systemPrompt).toContain(TASK_RESULT_PROMPT);
    evidence.push({ producerPath: path, systemPrompt: dump.systemPrompt, prompt: dump.prompt });
  };
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push(path.startsWith("/api/auth/") ? { method, path, status: result.status } : { method, path, body, result });
    return result;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const rows = () => readHandoffs(fixture.info.dataDir);
  let restarted: ChildProcess | undefined;
  let preview: MountedPreview | undefined;
  let browser: { binary: string; env: NodeJS.ProcessEnv } | undefined;
  try {
    const chief = (await cli("new-bot", "--name", "Cancellation Chief", "--section", "Leadership")).bot;
    const expert = (await cli("new-bot", "--name", "Cancellation Expert", "--section", "Engineering")).bot;
    expect((await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true })).status).toBe(200);
    const defaultBot = (await api("GET", "/api/bots?messages=0")).body.bots.find((b: { defaultBot?: unknown; id: string }) => Boolean(b.defaultBot));
    if (defaultBot) await api("PATCH", `/api/bots/${defaultBot.id}`, { welcomed: true });
    const plan: Record<string, unknown> = {
      [chief.id]: { steps: [{ arguments: { bot_ids: [expert.id], message: "Hold this exact job for cancellation" } }], reply: "Assigned", resumeReply: "MUST_NOT_RESUME_CANCELLED_JOB" },
      [expert.id]: { gateFile: join(fixture.info.dataDir, "expert-finish-gate"), reply: "Useful partial report" },
    };
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Assign the exact cancellation fixture job");
    await expect.poll(() => rows().some(row => row.parentId && row.status === "running"), { timeout: 20_000 }).toBe(true);
    const child = rows().find(row => row.parentId && row.status === "running")!;
    await assertProducerPrompt("delegated native turn", "Hold this exact job for cancellation");
    const root = rows().find(row => row.id === child.rootId)!;
    const invitation = await api("POST", "/api/auth/pairing", { label: "Chief cancellation fixture", scopes: ["client"] });
    const accepted = await api("POST", "/api/auth/pair", { code: invitation.body.code, label: "Paired Chief fixture" });
    expect(accepted.status).toBe(200);
    let token = accepted.body.token;
    const base = `/api/bots/${chief.id}/jobs/${root.id}`;
    expect((await api("GET", `/api/bots/${expert.id}/jobs/${root.id}/cancellation`, undefined, token)).status).toBe(404);
    expect((await api("POST", `/api/bots/${chief.id}/interrupt`, { threadId: root.threadId }, token)).status).toBe(200);
    expect(rows().find(row => row.id === child.id)?.status).toBe("running");
    const newerGate = join(fixture.info.dataDir, "newer-chief-finish-gate");
    plan[chief.id] = { gateFile: newerGate, reply: "NEWER_CHIEF_REQUEST_FINISHED" };
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
    await cli("send", "--bot", chief.id, "--task", root.threadId, "--text", "Keep this newer independent request running");
    await expect.poll(() => rows().some(row => !row.parentId && row.id !== root.id && row.botId === chief.id && row.status === "source"), { timeout: 15_000 }).toBe(true);
    const newer = rows().find(row => !row.parentId && row.id !== root.id && row.botId === chief.id && row.status === "source")!;
    await expect.poll(() => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).systemPrompt).toContain(TASK_RESULT_PROMPT);
    await assertProducerPrompt("ordinary first root native turn", "Keep this newer independent request running");
    const snapshot = await api("GET", `${base}/cancellation`, undefined, token);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({ rootId: root.id, sourceBotId: chief.id, sourceThreadId: root.threadId, generation: root.id });
    expect((await api("POST", `${base}/cancel`, { ...snapshot.body, unexpected: true }, token)).status).toBe(400);
    expect(rows().find(row => row.id === child.id)?.status).toBe("running");
    expect((await api("POST", "/api/auth/logout", {}, token)).status).toBe(200);
    expect((await api("POST", `${base}/cancel`, snapshot.body, token)).status).toBe(401);
    expect(rows().find(row => row.id === child.id)?.status).toBe("running");
    const replacementInvitation = await api("POST", "/api/auth/pairing", { label: "Replacement fixture session", scopes: ["client"] });
    const replacementSession = await api("POST", "/api/auth/pair", { code: replacementInvitation.body.code, label: "Replacement fixture client" });
    expect(replacementSession.status).toBe(200);
    token = replacementSession.body.token;
    const fresh = (await api("GET", `${base}/cancellation`, undefined, token)).body;
    if (process.env.OMB_UI_E2E === "1") {
      const tools = await ensureUiBrowser(process.env);
      preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__job-cancellation.html",
        title: "Exact Chief job cancellation", logLevel: "silent", proxyHeaders: { authorization: `Bearer ${token}` } });
      browser = { binary: tools.binary, env: sessionEnv({ home: fixture.info.dataDir, session: `jc-${process.pid}`, chrome: tools.chrome }) };
      browser.env.AGENT_BROWSER_SOCKET_DIR = "/tmp";
      if (process.env.OMB_UI_NO_SANDBOX === "1") browser.env.AGENT_BROWSER_ARGS = `${browser.env.AGENT_BROWSER_ARGS ?? ""}\n--no-sandbox`;
      const command = (...args: string[]) => agentBrowser(browser!.binary, browser!.env, args, 60_000);
      const evaluate = async (js: string) => (await command("eval", js)).result;
      await command("set", "viewport", "1280", "900");
      await command("open", preview.previewUrl);
      await expect.poll(() => evaluate(`(() => { const row = document.querySelector('[data-sidebar-bot-row="${chief.id}"]'); row?.click(); return Boolean(row); })()`), { timeout: 30_000 }).toBe(true);
      const label = "Cancel: Assign the exact cancellation fixture job";
      await expect.poll(() => evaluate(`Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === ${JSON.stringify(label)})`), { timeout: 30_000 }).toBe(true);
      expect(await evaluate(`Boolean(document.querySelector('button[title="Stop this turn"]'))`)).toBe(true);
      await evaluate(`(() => { const nativeFetch = window.fetch.bind(window); window.officeCancelRequests = []; window.fetch = async (input, init) => {
        const response = await nativeFetch(input, init); if (String(input).includes('/jobs/')) window.officeCancelRequests.push({ path: String(input), method: init?.method ?? 'GET', status: response.status }); return response;
      }; return true; })()`);
      const beforePng = `${fixture.info.logPath}.chief-cancel-before.png`;
      await command("screenshot", beforePng);
      await command("find", "role", "button", "click", "--name", label, "--exact");
      await expect.poll(async () => (await api("GET", `/api/threads/${root.threadId}/messages?limit=100`)).body.messages
        .find((message: any) => message.id === fresh.requestMessageId)?.jobCancellation?.state, { timeout: 15_000 }).toBe("cancelled");
      const requests = await evaluate("window.officeCancelRequests");
      expect(requests).toEqual([{ path: `${base}/cancellation`, method: "GET", status: 200 }, { path: `${base}/cancel`, method: "POST", status: 200 }]);
      const afterPng = `${fixture.info.logPath}.chief-cancel-after.png`;
      await expect.poll(() => evaluate(`document.querySelector('[data-current-job-id="${newer.id}"]')?.textContent`), { timeout: 15_000 }).toBe("Job running.");
      expect(await evaluate(`document.querySelector('[data-current-job-id]')?.textContent`)).not.toContain("Job cancelled.");
      await command("screenshot", afterPng);
      const consoleOutput = await command("console");
      expect(((consoleOutput.messages ?? []) as Array<{ type: string }>).filter(message => message.type === "error")).toEqual([]);
      evidence.push({ ui: { beforePng, afterPng, requests, console: consoleOutput } });
      console.info(JSON.stringify({ beforePng, afterPng }));
    } else {
      const cancelled = await api("POST", `${base}/cancel`, fresh, token);
      expect(cancelled).toMatchObject({ status: 200, body: { state: "cancelled", activeIds: [] } });
    }
    await expect.poll(() => rows().find(row => row.id === child.id)?.status, { timeout: 10_000 }).toBe("cancelled");
    await expect.poll(async () => {
      const inventory = (await api("GET", "/api/bots?messages=0")).body;
      return inventory.bots.find((bot: any) => bot.id === expert.id)?.tasks.find((task: any) => task.threadId === child.threadId)?.busy;
    }, { timeout: 10_000 }).toBe(false);
    expect((await api("POST", `${base}/cancel`, fresh, token)).body).toMatchObject({ state: "cancelled", alreadyCancelled: true });
    expect(rows().find(row => row.id === newer.id)?.status).toBe("source");
    writeFileSync(newerGate, "finish the newer fixture request");
    expect((await cli("wait", "--bot", chief.id, "--task", root.threadId, "--timeout", "15")).status).toBe("settled");
    const delegatedJob = (await api("GET", `/api/threads/${child.threadId}/job?since=0`)).body;
    expect(delegatedJob.current).toMatchObject({ rootId: child.id, status: "cancelled", state: "cancelled" });
    evidence.push({ delegatedJob });
    if (browser) {
      const delegatedPreview = await mountPreview(fixture, { entry: "/scripts/testing/job-status-preview.tsx", route: "/__delegated-status.html", title: "Delegated native job status", logLevel: "silent", proxyHeaders: { authorization: `Bearer ${token}` } });
      const command = (...args: string[]) => agentBrowser(browser!.binary, browser!.env, args, 60_000);
      try {
        await command("open", `${delegatedPreview.previewUrl}?bot=${expert.id}&thread=${child.threadId}`);
        await expect.poll(async () => (await command("eval", "document.querySelector('[data-current-job-id]')?.textContent")).result, { timeout: 30_000 }).toBe("Job cancelled. Partial reports are retained.");
        const delegatedCancelledPng = `${fixture.info.logPath}.delegated-cancelled.png`; await command("screenshot", delegatedCancelledPng); evidence.push({ delegatedCancelledPng });
      } finally { await delegatedPreview.close(); }
      await command("open", preview!.previewUrl);
      await expect.poll(async () => (await command("eval", `(() => { const row = document.querySelector('[data-sidebar-bot-row="${chief.id}"]'); row?.click(); return Boolean(row); })()`)).result, { timeout: 30_000 }).toBe(true);
    }

    const page = (await api("GET", `/api/threads/${root.threadId}/messages?limit=100`)).body;
    expect(page.messages.some((message: any) => message.text === "NEWER_CHIEF_REQUEST_FINISHED")).toBe(true);
    expect(page.messages.some((message: any) => message.text === "MUST_NOT_RESUME_CANCELLED_JOB")).toBe(false);
    expect(page.messages.filter((message: any) => message.roomRequest?.id === child.id && message.roomRequest.phase === "result")).toHaveLength(1);
    const source = page.messages.find((message: any) => message.id === fresh.requestMessageId);
    expect(source).toMatchObject({ requestCancelled: true, requestPending: false, jobCancellation: { rootId: root.id, state: "cancelled" } });
    const currentJob = (await api("GET", `/api/threads/${root.threadId}/job?since=0`, undefined, token)).body.current;
    expect(currentJob).toMatchObject({ rootId: newer.id, status: "completed", state: "completed", legacyTaskOutcome: true });
    if (browser && preview) {
      const command = (...args: string[]) => agentBrowser(browser!.binary, browser!.env, args, 60_000);
      const footer = async () => (await command("eval", `document.querySelector('[data-current-job-id="${newer.id}"]')?.textContent`)).result;
      await expect.poll(footer, { timeout: 15_000 }).toBe("Engine turn finished. Task outcome unrecorded and unverified.");
      await command("reload");
      await expect.poll(footer, { timeout: 30_000 }).toBe("Engine turn finished. Task outcome unrecorded and unverified.");
      const reloadedPng = `${fixture.info.logPath}.chief-status-reloaded.png`;
      await command("screenshot", reloadedPng);
      const consoleOutput = await command("console");
      expect(((consoleOutput.messages ?? []) as Array<{ type: string }>).filter(message => message.type === "error")).toEqual([]);
      evidence.push({ currentJob, afterReload: await footer(), cancelledReceiptPreserved: source.jobCancellation, reloadedPng, console: consoleOutput });
      console.info(JSON.stringify({ reloadedPng }));
    }

    plan[chief.id] = { steps: [{ arguments: { bot_ids: [expert.id], message: "Hold the job that the Chief will cancel with its tool" } }], reply: "Assigned another job" };
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
    await cli("send", "--bot", chief.id, "--task", root.threadId, "--text", "Assign another bounded fixture job");
    await expect.poll(() => rows().some(row => row.parentId && row.id !== child.id && row.status === "running"), { timeout: 15_000 }).toBe(true);
    const toolChild = rows().find(row => row.parentId && row.id !== child.id && row.status === "running")!;
    await api("POST", `/api/bots/${chief.id}/interrupt`, { threadId: root.threadId }, token);
    expect(rows().find(row => row.id === toolChild.id)?.status).toBe("running");
    plan[chief.id] = { steps: [{ tool: "assignment_status", arguments: {} }, { tool: "cancel_job", arguments: { job_id: toolChild.rootId } }], reply: "NATURAL_CANCEL_TOOL_FINISHED" };
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
    await cli("send", "--bot", chief.id, "--task", root.threadId, "--text", "Cancel the earlier job, including its running hand-off");
    expect((await cli("wait", "--bot", chief.id, "--task", root.threadId, "--timeout", "15")).status).toBe("settled");
    expect(rows().find(row => row.id === toolChild.id)?.status).toBe("cancelled");
    const toolPage = (await api("GET", `/api/threads/${root.threadId}/messages?limit=100`)).body;
    expect(toolPage.messages.some((message: any) => message.text === "NATURAL_CANCEL_TOOL_FINISHED")).toBe(true);
    expect(toolPage.messages.some((message: any) => message.jobCancellation?.rootId === toolChild.rootId && message.jobCancellation.state === "cancelled")).toBe(true);
    evidence.push({ naturalChiefTool: { rootId: toolChild.rootId, childId: toolChild.id, status: rows().find(row => row.id === toolChild.id)?.status } });
    plan[chief.id] = { reply: "Inspected publication prerequisites; the requested tool is absent.\n\nOPENMAUS_TASK_RESULT: {\"state\":\"blocked\",\"reason\":\"GitHub publishing tool unavailable\"}" };
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
    await cli("send", "--bot", chief.id, "--task", root.threadId, "--text", "Publish with the deliberately absent fixture tool");
    const blockedWait = await cli("wait", "--bot", chief.id, "--task", root.threadId, "--timeout", "15");
    const blockedJob = (await api("GET", `/api/threads/${root.threadId}/job?since=0`)).body;
    expect(blockedJob.current).toMatchObject({ status: "completed", state: "blocked", reason: "GitHub publishing tool unavailable", sourceRequest: "Publish with the deliberately absent fixture tool" });
    await assertProducerPrompt("ordinary blocked root finish", "Publish with the deliberately absent fixture tool");
    const blockedNode = blockedJob.nodes.find((node: any) => node.id === blockedJob.current.rootId);
    expect(blockedNode).toMatchObject({ disposition: { state: "blocked", reason: "GitHub publishing tool unavailable" }, result: "Inspected publication prerequisites; the requested tool is absent.\n\nOPENMAUS_TASK_RESULT: {\"state\":\"blocked\",\"reason\":\"GitHub publishing tool unavailable\"}" });
    if (browser && preview) {
      const command = (...args: string[]) => agentBrowser(browser!.binary, browser!.env, args, 60_000);
      await expect.poll(async () => (await command("eval", `document.querySelector('[data-current-job-id="${blockedJob.current.rootId}"]')?.textContent`)).result, { timeout: 15_000 }).toBe("Job blocked: GitHub publishing tool unavailable");
      const blockedPng = `${fixture.info.logPath}.blocked.png`;
      await command("screenshot", blockedPng);
      evidence.push({ blockedPng });
    }
    const legacy = (await cli("new-bot", "--name", "Legacy Publication", "--section", "Leadership")).bot;
    plan[legacy.id] = { reply: "Legacy publication account: completed without a typed task result" };
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
    await cli("send", "--bot", legacy.id, "--task", legacy.activeTaskId, "--text", "Preserve this legacy successful publication lifecycle");
    await cli("wait", "--bot", legacy.id, "--task", legacy.activeTaskId, "--timeout", "15");
    const legacyBefore = (await api("GET", `/api/threads/${legacy.activeTaskId}/job?since=0`)).body;
    expect(legacyBefore.current).toMatchObject({ status: "completed", state: "completed", legacyTaskOutcome: true, sourceRequest: "Preserve this legacy successful publication lifecycle" });
    const exited = once(fixture.child, "exit"); fixture.child.kill("SIGTERM"); await exited;
    const env = verificationServerEnvironment(process.env, fixture.info.dataDir, new URL(fixture.info.url).port ? Number(new URL(fixture.info.url).port) : 0);
    const log = openSync(fixture.info.logPath, "a");
    restarted = spawn(process.execPath, verificationServerArgs(env), { cwd: process.cwd(), env, stdio: ["ignore", log, log] });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await api("GET", `/api/threads/${root.threadId}/job?since=0`)).body.current?.state; } catch { return null; }
    }, { timeout: 20_000 }).toBe("blocked");
    if (browser && preview) {
      const command = (...args: string[]) => agentBrowser(browser!.binary, browser!.env, args, 60_000);
      await command("reload");
      await expect.poll(async () => (await command("eval", `document.querySelector('[data-current-job-id="${blockedJob.current.rootId}"]')?.textContent`)).result, { timeout: 30_000 }).toBe("Job blocked: GitHub publishing tool unavailable");
      const restartedPng = `${fixture.info.logPath}.blocked-restarted.png`; await command("screenshot", restartedPng); evidence.push({ restartedPng });
    }
    const blockedAfterRestart = (await api("GET", `/api/threads/${root.threadId}/job?since=0`)).body;
    expect(blockedAfterRestart.current).toEqual(blockedJob.current);
    expect(blockedAfterRestart.nodes.find((node: any) => node.id === blockedNode.id)).toEqual(blockedNode);
    evidence.push({ blockedAfterRestart });
    const legacyAfter = (await api("GET", `/api/threads/${legacy.activeTaskId}/job?since=0`)).body;
    expect(legacyAfter.current).toEqual(legacyBefore.current);
    expect(legacyAfter.nodes).toEqual(legacyBefore.nodes);
    if (browser) {
      const command = (...args: string[]) => agentBrowser(browser!.binary, browser!.env, args, 60_000);
      const legacyPreview = await mountPreview(fixture, { entry: "/scripts/testing/job-status-preview.tsx", route: "/__legacy-job.html", title: "Legacy untyped lifecycle", logLevel: "silent" });
      try {
        await command("open", `${legacyPreview.previewUrl}?bot=${legacy.id}&thread=${legacy.activeTaskId}`);
        const legacyFooter = async () => (await command("eval", "document.querySelector('[data-current-job-id]')?.textContent")).result;
        await expect.poll(legacyFooter, { timeout: 30_000 }).toBe("Engine turn finished. Task outcome unrecorded and unverified.");
        await command("reload");
        await expect.poll(legacyFooter, { timeout: 30_000 }).toBe("Engine turn finished. Task outcome unrecorded and unverified.");
        const legacyPng = `${fixture.info.logPath}.legacy-restarted.png`; await command("screenshot", legacyPng); evidence.push({ legacyBefore, legacyAfter, legacyPng });
      } finally { await legacyPreview.close(); }
      await command("open", preview!.previewUrl);
      await expect.poll(async () => (await command("eval", `(() => { const row = document.querySelector('[data-sidebar-bot-row="${chief.id}"]'); row?.click(); return Boolean(row); })()`)).result, { timeout: 30_000 }).toBe(true);
    }
    plan[chief.id] = { reply: 'PUBLISHED_FIXTURE_SUCCESS\n\nOPENMAUS_TASK_RESULT: {"state":"completed"}' };
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
    await cli("send", "--bot", chief.id, "--task", root.threadId, "--text", "Complete the newer isolated success request");
    await cli("wait", "--bot", chief.id, "--task", root.threadId, "--timeout", "15");
    const successAfterRestart = (await api("GET", `/api/threads/${root.threadId}/job?since=0`)).body;
    expect(successAfterRestart.current).toMatchObject({ status: "completed", state: "completed" });
    expect(successAfterRestart.current.legacyTaskOutcome).toBeUndefined();
    expect(successAfterRestart.nodes.find((node: any) => node.id === successAfterRestart.current.rootId).disposition).toEqual({ state: "completed" });
    expect(successAfterRestart.current.rootId).not.toBe(blockedJob.current.rootId);
    evidence.push({ blockedWait, blockedJob, successAfterRestart });
    if (browser) {
      const command = (...args: string[]) => agentBrowser(browser!.binary, browser!.env, args, 60_000);
      await command("reload");
      await expect.poll(async () => (await command("eval", `document.querySelector('[data-current-job-id="${successAfterRestart.current.rootId}"]')?.textContent`)).result, { timeout: 30_000 }).toBe("Job completed.");
      const successPng = `${fixture.info.logPath}.success-after-restart.png`; await command("screenshot", successPng); evidence.push({ successPng });
    }

    plan[chief.id] = { steps: [{ arguments: { bot_ids: [expert.id], message: "Return a bounded explicit completion report" } }], reply: "Assigned bounded fixture work", resumeReply: 'Reviewed the teammate result.\n\nOPENMAUS_TASK_RESULT: {"state":"completed"}' };
    plan[expert.id] = { reply: 'Checked the fixture file.\n\nOPENMAUS_TASK_RESULT: {"state":"completed"}' };
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
    await cli("send", "--bot", chief.id, "--task", root.threadId, "--text", "Delegate and review the bounded fixture work");
    await cli("wait", "--bot", chief.id, "--task", root.threadId, "--timeout", "20");
    const resumedJob = (await api("GET", `/api/threads/${root.threadId}/job?since=0`)).body;
    expect(resumedJob.current).toMatchObject({ status: "completed", state: "completed" });
    const resumedRoot = resumedJob.nodes.find((node: any) => node.id === resumedJob.current.rootId);
    expect(resumedRoot.disposition).toEqual({ state: "completed" });
    expect(resumedRoot.executions).toBeGreaterThan(1);
    await assertProducerPrompt("resumed root native turn", "Your downstream room requests have settled");
    evidence.push({ resumedJob });

  } finally {
    const evidencePath = `${fixture.info.logPath}.job-cancellation.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, limitation: "Isolated HTTP/native runtime with fake providers only" }, null, 2));
    console.info(JSON.stringify({ evidencePath, logPath: fixture.info.logPath }));
    if (browser) await agentBrowser(browser.binary, browser.env, ["close"]).catch(() => {});
    await preview?.close();
    if (restarted && restarted.exitCode === null) { const exited = once(restarted, "exit"); restarted.kill("SIGTERM"); await exited; }
    await fixture.close();
  }
}, process.env.OMB_UI_E2E === "1" ? 240_000 : 60_000);
