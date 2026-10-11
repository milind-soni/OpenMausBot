// A teammate's run crashes; nobody is at the keyboard. The Chief of Staff
// is told in its own "Team incidents" thread, with a link to the broken
// thread, and can resume it from there — the person's phone shows one
// place to read. Pinned against the real server with the fake CLI failing
// exactly the runs each test names.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

/** A verification server and the calls every test makes against it;
 * `boat` is a loopback stand-in for the Boat provider, when one is needed. */
async function launch(boat?: string) {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], boat);
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, token?: string, expectedStatus = 200) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: url }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(expectedStatus);
    return value;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const file = (threadId: string, extension: string) => join(dataDir, `${threadId}.${extension}`);
  const dump = async (threadId: string) => {
    await expect.poll(() => existsSync(file(threadId, "json")), { timeout: 20_000 }).toBe(true);
    return JSON.parse(readFileSync(file(threadId, "json"), "utf8"));
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const botsNow = async () => (await api("GET", "/api/bots")).bots as any[];
  // Every real turn dumps to <thread>.json and, when "slow", is held open
  // by <thread>.gate so its token stays live and timing is deterministic.
  // `mode` is a JS expression over `thread` naming that turn's fake mode.
  const useCli = async (mode: string) => {
    const wrapper = join(dataDir, "incident-cli.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { existsSync, readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const at = process.argv.indexOf("--mcp-config");',
      'const thread = at < 0 ? "probe" : JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers?.agents?.env?.OMB_THREAD_ID ?? "probe";',
      `process.env.FAKE_CLAUDE_MODE = thread === "probe" ? "happy" : ${mode};`,
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(dataDir)}, thread + ".gate");`,
      `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(dataDir)}, thread + ".json");`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
  };
  const incidentsThread = async (botId: string) => {
    await expect.poll(async () => (await botsNow()).find((b) => b.id === botId)?.tasks?.some((t: any) => t.title === "Team incidents"), { timeout: 20_000 }).toBe(true);
    return (await botsNow()).find((b) => b.id === botId).tasks.find((t: any) => t.title === "Team incidents") as { threadId: string };
  };
  return { url, dataDir, api, control, file, dump, messages, botsNow, useCli, incidentsThread, close: () => fixture.close() };
}

it("reports a crashed run to the Chief, who retries it from the incidents thread", async () => {
  const { url, dataDir, api, control, file, dump, messages, botsNow, useCli, close } = await launch();
  try {
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const ada = (await control(["new-bot", "--name", "Ada", "--section", "Ops"])).bot;
    const fixedFlag = join(dataDir, "ada-fixed");
    // Ada's own thread crashes before any result until the flag appears.
    await useCli(`thread === ${JSON.stringify(ada.activeTaskId)} && !existsSync(${JSON.stringify(fixedFlag)}) ? "exit-early" : "slow"`);

    // The person asks Ada for something and walks away; Ada's run dies.
    await control(["send", "--bot", ada.id, "--text", "Reconcile the September invoices."]);
    await expect.poll(async () => (await messages(ada.activeTaskId)).some((m) => m.kind === "activity" && /exit_before_result|error/i.test(m.tool?.name ?? "")), { timeout: 20_000 }).toBe(true);

    // The Chief gets a "Team incidents" thread with the chip and a link to Ada's thread…
    await expect.poll(async () => (await botsNow()).find((b) => b.id === chief.id)?.tasks?.some((t: any) => t.title === "Team incidents"), { timeout: 20_000 }).toBe(true);
    const incidents = (await botsNow()).find((b) => b.id === chief.id).tasks.find((t: any) => t.title === "Team incidents");
    await expect.poll(async () => (await messages(incidents.threadId)).some((m) =>
      m.kind === "activity" && m.tool?.name === 'Incident: Ada\'s run in its thread #Reconcile the September invoices. failed: "exit_before_result"' && m.threadRef?.threadId === ada.activeTaskId && m.threadRef?.botId === ada.id,
    ), { timeout: 10_000 }).toBe(true);
    // …and a turn of its own carrying the report, marked as not from the person.
    const chiefRun = await dump(incidents.threadId);
    const prompt = JSON.stringify(chiefRun.prompt);
    expect(prompt).toContain("[Incident report from OpenMausBot — not from the person.");
    expect(prompt).toContain("Ada's run in its thread #Reconcile the September invoices. failed");
    expect(prompt).toContain("Reconcile the September invoices.");
    expect(prompt).toContain(`retry_thread with bot_id \\"${ada.id}\\" and thread_id \\"${ada.activeTaskId}\\"`);
    expect(chiefRun.systemPrompt).toContain("Team incidents");
    expect(chiefRun.systemPrompt).toContain("retry_thread");
    const reportLine = (await messages(incidents.threadId)).find((m) => m.role === "user" && /Incident report/.test(m.text ?? ""));
    expect(reportLine?.peerAsk).toMatchObject({ botId: ada.id, name: "Ada", unattended: true, incident: true });

    // From that turn the Chief resumes Ada's thread; the cause is fixed by now.
    const token = chiefRun.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    writeFileSync(fixedFlag, "fixed");
    const retry = { fromBotId: chief.id, fromThreadId: incidents.threadId, toBotId: ada.id, toThreadId: ada.activeTaskId };
    expect(await api("POST", "/api/internal/retry-thread", { ...retry, note: "The service was down; try again." }, token, 200)).toMatchObject({ started: true });
    // while it runs a second retry is refused; so is a thread that does not exist
    expect((await api("POST", "/api/internal/retry-thread", retry, token, 409)).error).toMatch(/still running/);
    expect((await api("POST", "/api/internal/retry-thread", { ...retry, toThreadId: "no-such-thread" }, token, 404)).error).toMatch(/no such thread/);
    writeFileSync(file(incidents.threadId, "gate"), "finish");
    expect((await control(["wait", "--bot", chief.id, "--task", incidents.threadId, "--timeout", "30"])).status).toBe("settled");

    // The retry carried the Chief's name and reason; Ada finished this time.
    writeFileSync(file(ada.activeTaskId, "gate"), "finish");
    await expect.poll(async () => (await control(["wait", "--bot", ada.id, "--timeout", "30"])).status, { timeout: 40_000 }).toBe("settled");
    const adaMessages = await messages(ada.activeTaskId);
    const retryLine = adaMessages.find((m) => m.role === "user" && /Retry requested by Clive, your Chief of Staff/.test(m.text ?? ""));
    expect(retryLine?.text).toContain("Note from Clive: The service was down; try again.");
    expect(retryLine?.peerAsk).toMatchObject({ botId: chief.id, name: "Clive" });
    expect(adaMessages.filter((m) => m.role === "bot" && m.kind === "text" && m.text).length).toBeGreaterThan(0);
    expect((await messages(incidents.threadId)).some((m) => m.kind === "activity" && (m.tool?.name ?? "").startsWith("Retried Ada's thread #") && m.threadRef?.threadId === ada.activeTaskId)).toBe(true);

    // Only a Chief may retry: Ada's own token is refused.
    const adaRun = JSON.parse(readFileSync(file(ada.activeTaskId, "json"), "utf8"));
    const adaToken = adaRun.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const refused = await fetch(`${url}/api/internal/retry-thread`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${adaToken}` },
      body: JSON.stringify({ fromBotId: ada.id, fromThreadId: ada.activeTaskId, toBotId: chief.id, toThreadId: incidents.threadId }),
    });
    expect([401, 403]).toContain(refused.status);
  } finally {
    await close();
  }
}, 150_000);

it("queues a report that finds the Chief's incidents thread busy, and answers each without the Chief's computer", async () => {
  const { api, control, file, dump, messages, useCli, incidentsThread, close } = await launch();
  try {
    // The Chief works on a cloud computer this home has no Boat key for, so
    // any turn that needed it would be refused; a report needs none.
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, computer: "cloud" });
    const ada = (await control(["new-bot", "--name", "Ada", "--section", "Ops"])).bot;
    const ben = (await control(["new-bot", "--name", "Ben", "--section", "Ops"])).bot;
    // Ada's and Ben's runs crash before any result; the Chief's are gated.
    await useCli(`[${JSON.stringify(ada.activeTaskId)}, ${JSON.stringify(ben.activeTaskId)}].includes(thread) ? "exit-early" : "slow"`);

    // Ada's run dies; the Chief's report turn runs although its Works-on
    // computer cannot start, and nothing of a computer is mounted for it.
    await control(["send", "--bot", ada.id, "--text", "Reconcile the September invoices."]);
    const incidents = (await incidentsThread(chief.id)).threadId;
    const first = await dump(incidents);
    expect(JSON.stringify(first.prompt)).toContain("Ada's run in its thread #Reconcile the September invoices. failed");
    expect(Object.keys(first.mcpConfig.mcpServers)).toContain("agents");
    expect(Object.keys(first.mcpConfig.mcpServers)).not.toContain("computer");
    expect(first.systemPrompt).toContain("This turn answers a Team incidents report, so no computer and no built-in browser are mounted");
    expect(first.systemPrompt).not.toContain("Boat key");

    // While that report is still being handled, Ben's run dies too: the
    // second report waits for the Chief instead of bouncing off its busy
    // thread, which used to drop it with "this thread is already working".
    await control(["send", "--bot", ben.id, "--text", "Draft the vendor letter."]);
    await expect.poll(async () => (await messages(incidents)).some((m) =>
      m.kind === "activity" && (m.tool?.name ?? "").startsWith("Incident: Ben's run in its thread #Draft the vendor letter. failed") && m.threadRef?.threadId === ben.activeTaskId,
    ), { timeout: 20_000 }).toBe(true);
    expect((await messages(incidents)).filter((m) => m.role === "user" && /Incident report/.test(m.text ?? "")).length).toBe(1);
    expect((await messages(incidents)).some((m) => /could not reach|error:/.test(m.tool?.name ?? ""))).toBe(false);

    // The first report settles; the queued one runs as the Chief's next
    // turn the moment it does, again with no computer.
    writeFileSync(file(incidents, "gate"), "finish");
    await expect.poll(async () => JSON.stringify((await dump(incidents)).prompt), { timeout: 20_000 }).toContain("Ben's run in its thread #Draft the vendor letter. failed");
    const second = await dump(incidents);
    expect(Object.keys(second.mcpConfig.mcpServers)).not.toContain("computer");
    expect(second.systemPrompt).toContain("This turn answers a Team incidents report");
    expect((await control(["wait", "--bot", chief.id, "--task", incidents, "--timeout", "30"])).status).toBe("settled");

    // Each report got its own answer, and both requests settled: the first
    // was replaced at its own turn.completed, before its settle had run.
    const lines = await messages(incidents);
    const reports = lines.filter((m) => m.role === "user" && /Incident report/.test(m.text ?? ""));
    expect(reports.map((m) => m.peerAsk)).toEqual([
      { botId: ada.id, name: "Ada", unattended: true, incident: true },
      { botId: ben.id, name: "Ben", unattended: true, incident: true },
    ]);
    expect(reports.map((report) => lines.some((m) =>
      m.role === "bot" && m.kind === "text" && m.turnTerminal && m.requestMessageId === report.id))).toEqual([true, true]);
    expect(reports.map((m) => m.requestPending)).toEqual([false, false]);
    expect(lines.some((m) => /could not reach|error:/.test(m.tool?.name ?? ""))).toBe(false);
  } finally {
    await close();
  }
}, 150_000);

it("reviews the work it handed on from a report without the Chief's computer", async () => {
  const { api, control, file, dump, messages, useCli, incidentsThread, close } = await launch();
  try {
    // As above, the Chief's Works-on computer cannot start here.
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, computer: "cloud" });
    const ada = (await control(["new-bot", "--name", "Ada", "--section", "Ops"])).bot;
    const cara = (await control(["new-bot", "--name", "Cara", "--section", "Ops"])).bot;
    await useCli(`thread === ${JSON.stringify(ada.activeTaskId)} ? "exit-early" : "slow"`);

    // Ada's run dies; from the report turn the Chief hands the work to Cara.
    await control(["send", "--bot", ada.id, "--text", "Reconcile the September invoices."]);
    const incidents = (await incidentsThread(chief.id)).threadId;
    const token = (await dump(incidents)).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const handed = await api("POST", "/api/internal/coordinate-bots", { botIds: [cara.id], message: "Reconcile the September invoices; Ada's run crashed." }, token);
    const caraThread = handed.receipts[0].threadId as string;
    writeFileSync(file(caraThread, "gate"), "finish");
    writeFileSync(file(incidents, "gate"), "finish");

    // Cara's result resumes the Chief in the incidents thread: that review
    // continues the report, so the Chief's computer cannot refuse it either.
    await expect.poll(async () => (await messages(incidents)).some((m) =>
      m.kind === "activity" && m.tool?.name === "Resumed with Cara results, reviewing"), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => JSON.stringify((await dump(incidents)).prompt), { timeout: 20_000 }).toContain("Your downstream room requests have settled");
    expect((await control(["wait", "--bot", chief.id, "--task", incidents, "--timeout", "30"])).status).toBe("settled");
    const lines = await messages(incidents);
    expect(lines.some((m) => /could not reach|error:|Boat key/.test(m.tool?.name ?? ""))).toBe(false);
    const report = lines.find((m) => m.role === "user" && /Incident report/.test(m.text ?? ""));
    expect(lines.filter((m) => m.role === "bot" && m.kind === "text" && m.turnTerminal && m.requestMessageId === report.id).length).toBe(2);
    expect(report.requestPending).toBe(false);
  } finally {
    await close();
  }
}, 150_000);

it("answers a report about the team's missing computer although the Chief shares that computer", async () => {
  // A loopback Boat: the team computer is created, then disappears.
  const boxes: Array<{ id: string; name: string; state: string }> = [];
  let gone = false;
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (path === "/boxes" && req.method === "POST") {
      const box = { id: `bx_${boxes.length + 23456789}`, name: body.name, state: "idle" };
      boxes.push(box);
      return res.end(JSON.stringify({ box }));
    }
    if (path === "/boxes") return res.end(JSON.stringify({ boxes: gone ? [] : boxes }));
    if (path.endsWith("/desktop")) return res.end(JSON.stringify({ desktopUrl: "https://desktop.fixture.invalid" }));
    const box = gone ? undefined : boxes.find((row) => path === `/boxes/${row.id}`);
    if (box) {
      if (req.method === "PATCH" && typeof body.name === "string") box.name = body.name;
      return res.end(JSON.stringify({ box }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  const { api, control, dump, messages, useCli, incidentsThread, close } = await launch(`http://127.0.0.1:${address.port}`);
  try {
    // Ada and the Chief both work on Auto, so both inherit the Ops team's
    // shared computer — the one Ada's incident is about.
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const ada = (await control(["new-bot", "--name", "Ada", "--section", "Ops"])).bot;
    await useCli('"happy"');
    const requestId = randomUUID();
    await api("POST", "/api/team-computers", { requestId, name: "Ops desktop", acknowledgeCost: true }, undefined, 201);
    await api("PATCH", `/api/team-computers/${requestId}`, { section: "Ops", acknowledgeSharedAccess: true });
    gone = true;

    // Ada's run cannot start on the missing machine; the Chief's report turn
    // still runs, with nothing of that machine mounted.
    await control(["send", "--bot", ada.id, "--text", "Reconcile the September invoices."]);
    const incidents = (await incidentsThread(chief.id)).threadId;
    await expect.poll(async () => (await messages(incidents)).some((m) =>
      m.kind === "activity" && /^Incident: Ada's run in its thread #Reconcile the September invoices\. could not start: .*cloud computer is missing/.test(m.tool?.name ?? ""),
    ), { timeout: 20_000 }).toBe(true);
    const run = await dump(incidents);
    expect(Object.keys(run.mcpConfig.mcpServers)).not.toContain("computer");
    expect(run.systemPrompt).toContain("This turn answers a Team incidents report");
    expect(run.systemPrompt).not.toContain("Your team shares the cloud computer");
    expect((await control(["wait", "--bot", chief.id, "--task", incidents, "--timeout", "30"])).status).toBe("settled");
    expect((await messages(incidents)).some((m) => /could not reach|error:/.test(m.tool?.name ?? ""))).toBe(false);
  } finally {
    await close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 150_000);
