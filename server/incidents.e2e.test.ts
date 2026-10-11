// A teammate's run crashes; nobody is at the keyboard. The Chief of Staff
// is told in its own "Team incidents" thread, with a link to the broken
// thread, and can resume it from there — the person's phone shows one
// place to read. Pinned against the real server with the fake CLI failing
// exactly the runs each test names.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

/** A verification server and the calls every test makes against it;
 * `boat` is a loopback stand-in for the Boat provider, and `enterprise` a
 * stand-in layer for entitled behaviour (the spend limit), when needed. */
async function launch(boat?: string, enterprise?: { dir: string; licenseKey: string }) {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, enterprise, undefined, [], boat);
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
  // A thread's own turn has ended, though work it handed on may still be
  // out (`control wait` waits for that work too).
  const turnEnded = (botId: string, threadId: string) => expect.poll(async () =>
    (await botsNow()).find((b) => b.id === botId)?.tasks?.find((t: any) => t.threadId === threadId)?.busy, { timeout: 30_000 }).toBe(false);
  const incidentsThread = async (botId: string) => {
    await expect.poll(async () => (await botsNow()).find((b) => b.id === botId)?.tasks?.some((t: any) => t.title === "Team incidents"), { timeout: 20_000 }).toBe(true);
    return (await botsNow()).find((b) => b.id === botId).tasks.find((t: any) => t.title === "Team incidents") as { threadId: string };
  };
  // Every push the person would get, from this point on.
  const pushes = async () => {
    const stream = await openSse(`${url}/api/events`, { origin: url });
    return {
      stream,
      /** The pushes so far: a unique bot patch is an SSE ordering barrier,
       * so by the time it is seen every earlier push has been too. */
      sent: async (botId: string) => {
        const name = `Barrier ${randomUUID().slice(0, 8)}`;
        await api("PATCH", `/api/bots/${botId}`, { name });
        await stream.until((frame) => frame.kind === "bot" && frame.bot?.name === name, 10_000);
        return stream.frames.filter((frame) => frame.kind === "notify").map((frame) => frame.notification);
      },
    };
  };
  return { url, dataDir, api, control, file, dump, messages, botsNow, useCli, turnEnded, incidentsThread, pushes, close: () => fixture.close() };
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
    expect(reportLine?.peerAsk).toEqual({ botId: ada.id, name: "Ada", unattended: true, incident: { threadId: ada.activeTaskId } });

    // From that turn the Chief resumes Ada's thread; the cause is fixed by now.
    const token = chiefRun.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    writeFileSync(fixedFlag, "fixed");
    const retry = { fromBotId: chief.id, fromThreadId: incidents.threadId, toBotId: ada.id, toThreadId: ada.activeTaskId };
    expect(await api("POST", "/api/internal/retry-thread", { ...retry, note: "The service was down; try again." }, token, 200)).toMatchObject({ started: true });
    // while it runs a second retry is refused; so is a thread that does not exist
    expect((await api("POST", "/api/internal/retry-thread", retry, token, 409)).error).toMatch(/still running/);
    expect((await api("POST", "/api/internal/retry-thread", { ...retry, toThreadId: "no-such-thread" }, token, 404)).error).toMatch(/no such thread/);

    // Ada finishes this time; once she has, asking again would redo her work.
    writeFileSync(file(ada.activeTaskId, "gate"), "finish");
    await expect.poll(async () => (await control(["wait", "--bot", ada.id, "--timeout", "30"])).status, { timeout: 40_000 }).toBe("settled");
    expect((await api("POST", "/api/internal/retry-thread", retry, token, 409)).error).toMatch(/finished a run since it was reported/);
    writeFileSync(file(incidents.threadId, "gate"), "finish");
    expect((await control(["wait", "--bot", chief.id, "--task", incidents.threadId, "--timeout", "30"])).status).toBe("settled");

    // The retry carried the Chief's name and reason.
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

it("queues reports that find the Chief's incidents thread busy, answers them together, and runs each without a computer it cannot have", async () => {
  const { api, control, file, dump, messages, useCli, incidentsThread, close } = await launch();
  try {
    // The Chief works on a cloud computer this home has no Boat key for, so
    // any other turn of its would be refused; a report goes on without it.
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, computer: "cloud" });
    const ada = (await control(["new-bot", "--name", "Ada", "--section", "Ops"])).bot;
    const ben = (await control(["new-bot", "--name", "Ben", "--section", "Ops"])).bot;
    const cara = (await control(["new-bot", "--name", "Cara", "--section", "Ops"])).bot;
    // Their runs crash before any result; the Chief's are gated.
    await useCli(`${JSON.stringify([ada.activeTaskId, ben.activeTaskId, cara.activeTaskId])}.includes(thread) ? "exit-early" : "slow"`);

    // Ada's run dies; the Chief's report turn runs although its Works-on
    // computer cannot start: nothing of a computer is mounted, and the
    // Chief is told why rather than the report being refused.
    await control(["send", "--bot", ada.id, "--text", "Reconcile the September invoices."]);
    const incidents = (await incidentsThread(chief.id)).threadId;
    const first = await dump(incidents);
    expect(JSON.stringify(first.prompt)).toContain("Ada's run in its thread #Reconcile the September invoices. failed");
    expect(Object.keys(first.mcpConfig.mcpServers)).toContain("agents");
    expect(Object.keys(first.mcpConfig.mcpServers)).not.toContain("computer");
    expect(first.systemPrompt).toContain("This turn answers a Team incidents report and your computer could not be prepared for it (A cloud computer here needs your own Boat key");

    // While that report is still being handled, Ben's and Cara's runs die
    // too: both reports wait for the Chief instead of bouncing off its busy
    // thread, which used to drop them with "this thread is already working".
    const failsWhileBusy = async (bot: { id: string; activeTaskId: string }, name: string, request: string) => {
      await control(["send", "--bot", bot.id, "--text", request]);
      await expect.poll(async () => (await messages(incidents)).some((m) =>
        m.kind === "activity" && (m.tool?.name ?? "").startsWith(`Incident: ${name}'s run in its thread #${request} failed`) && m.threadRef?.threadId === bot.activeTaskId,
      ), { timeout: 20_000 }).toBe(true);
    };
    await failsWhileBusy(ben, "Ben", "Draft the vendor letter.");
    await failsWhileBusy(cara, "Cara", "File the expense report.");
    expect((await messages(incidents)).filter((m) => m.role === "user" && /Incident report/.test(m.text ?? "")).length).toBe(1);
    expect((await messages(incidents)).some((m) => /could not reach|error:/.test(m.tool?.name ?? ""))).toBe(false);

    // The first report settles; the two that waited run as the Chief's next
    // turn, together — whichever bot they are about — again with no computer.
    writeFileSync(file(incidents, "gate"), "finish");
    await expect.poll(async () => JSON.stringify((await dump(incidents)).prompt), { timeout: 20_000 }).toContain("Ben's run in its thread #Draft the vendor letter. failed");
    const second = await dump(incidents);
    expect(JSON.stringify(second.prompt)).toContain("Cara's run in its thread #File the expense report. failed");
    expect(Object.keys(second.mcpConfig.mcpServers)).not.toContain("computer");
    expect(second.systemPrompt).toContain("This turn answers a Team incidents report and your computer could not be prepared for it");
    expect((await control(["wait", "--bot", chief.id, "--task", incidents, "--timeout", "30"])).status).toBe("settled");

    // Two turns answered three reports, and both requests settled: the first
    // was replaced at its own turn.completed, before its settle had run; the
    // second is the line its waiting group ended on.
    const lines = await messages(incidents);
    const reports = lines.filter((m) => m.role === "user" && /Incident report/.test(m.text ?? ""));
    expect(reports.map((m) => m.peerAsk)).toEqual([ada, ben, cara].map((bot, at) => ({
      botId: bot.id, name: ["Ada", "Ben", "Cara"][at], unattended: true, incident: { threadId: bot.activeTaskId },
    })));
    expect(lines.filter((m) => m.role === "bot" && m.kind === "text" && m.turnTerminal).map((m) => m.requestMessageId))
      .toEqual([reports[0].id, reports[2].id]);
    expect(reports.map((m) => m.requestPending)).toEqual([false, undefined, false]);
    expect(lines.some((m) => /could not reach|error:/.test(m.tool?.name ?? ""))).toBe(false);
  } finally {
    await close();
  }
}, 150_000);

it("reviews the work it handed on from a report without the Chief's computer, even after the person wrote there", async () => {
  const { api, control, file, dump, messages, useCli, turnEnded, incidentsThread, close } = await launch();
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
    writeFileSync(file(incidents, "gate"), "finish");
    await turnEnded(chief.id, incidents);

    // While Cara works, the person asks in the incidents thread. That is
    // their own turn: it needs the Chief's computer and is refused for it,
    // as any of their turns is.
    await control(["send", "--bot", chief.id, "--task", incidents, "--text", "Any update on the invoices?"]);
    await expect.poll(async () => (await messages(incidents)).some((m) => m.kind === "activity" && /Boat key/.test(m.tool?.name ?? "")), { timeout: 20_000 }).toBe(true);
    const refusals = (await messages(incidents)).filter((m) => m.kind === "activity" && /Boat key/.test(m.tool?.name ?? "")).length;

    // Cara's result resumes the Chief: that review continues the report the
    // work came from — not the person's later line — so the Chief's
    // computer cannot refuse it either.
    writeFileSync(file(caraThread, "gate"), "finish");
    await expect.poll(async () => (await messages(incidents)).some((m) =>
      m.kind === "activity" && m.tool?.name === "Resumed with Cara results, reviewing"), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => JSON.stringify((await dump(incidents)).prompt), { timeout: 20_000 }).toContain("Your downstream room requests have settled");
    const review = await dump(incidents);
    expect(Object.keys(review.mcpConfig.mcpServers)).not.toContain("computer");
    expect(review.systemPrompt).toContain("This turn answers a Team incidents report and your computer could not be prepared for it");
    expect((await control(["wait", "--bot", chief.id, "--task", incidents, "--timeout", "30"])).status).toBe("settled");
    const lines = await messages(incidents);
    expect(lines.filter((m) => m.kind === "activity" && /Boat key/.test(m.tool?.name ?? "")).length).toBe(refusals);
    expect(lines.some((m) => /could not reach/.test(m.tool?.name ?? ""))).toBe(false);
    const reviewReply = lines.findLast((m) => m.role === "bot" && m.kind === "text" && m.turnTerminal);
    expect(lines.indexOf(reviewReply)).toBeGreaterThan(lines.findIndex((m) => m.tool?.name === "Resumed with Cara results, reviewing"));
  } finally {
    await close();
  }
}, 150_000);

it("keeps the team computer for a report turn, and answers without it once it is missing", async () => {
  // A loopback Boat: the team computer is created, then disappears. One
  // listing can be held open, to keep a Boat account change in flight.
  const boxes: Array<{ id: string; name: string; state: string }> = [];
  let gone = false;
  let hold: { held?: () => void; release?: Promise<void> } | null = null;
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (path === "/boxes" && req.method === "GET" && hold?.release) {
      const { held, release } = hold;
      hold = null;
      held?.();
      await release;
    }
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
  const { api, control, file, dump, messages, useCli, incidentsThread, close } = await launch(`http://127.0.0.1:${address.port}`);
  try {
    // The Chief and its teammates work on Auto, so all of them inherit the
    // Ops team's shared computer — except Ben, set to Off.
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const bot = async (name: string) => (await control(["new-bot", "--name", name, "--section", "Ops"])).bot as { id: string; activeTaskId: string };
    const team = { ada: await bot("Ada"), ben: await bot("Ben"), cara: await bot("Cara"), dan: await bot("Dan") };
    await api("PATCH", `/api/bots/${team.ben.id}`, { computer: "off" });
    await useCli(`${JSON.stringify([team.ada.activeTaskId, team.ben.activeTaskId])}.includes(thread) ? "exit-early" : "slow"`);
    const requestId = randomUUID();
    await api("POST", "/api/team-computers", { requestId, name: "Ops desktop", acknowledgeCost: true }, undefined, 201);
    await api("PATCH", `/api/team-computers/${requestId}`, { section: "Ops", acknowledgeSharedAccess: true });
    const reportRan = (pattern: string) => expect.poll(async () => JSON.stringify((await dump(incidents)).prompt), { timeout: 20_000 }).toContain(pattern);
    let incidents = "";

    // Ada's run crashes for a reason of its own. The Chief's report turn has
    // the team computer like any of its turns, so it can still look for
    // itself: a report needs no computer, but loses none it can have.
    await control(["send", "--bot", team.ada.id, "--text", "Reconcile the September invoices."]);
    incidents = (await incidentsThread(chief.id)).threadId;
    const first = await dump(incidents);
    expect(JSON.stringify(first.prompt)).toContain("Ada's run in its thread #Reconcile the September invoices. failed");
    expect(Object.keys(first.mcpConfig.mcpServers)).toContain("computer");
    expect(first.systemPrompt).toContain("Your team shares the cloud computer");
    expect(first.systemPrompt).not.toContain("could not be prepared");
    writeFileSync(file(incidents, "gate"), "finish");
    expect((await control(["wait", "--bot", chief.id, "--task", incidents, "--timeout", "30"])).status).toBe("settled");

    // The Boat account is being changed — any turn on that computer is
    // refused until it is done. Ben's run (on no computer) crashes
    // meanwhile; the Chief's report turn runs without the computer.
    let releaseListing = () => {};
    const listingHeld = new Promise<void>((resolve) => {
      hold = { held: resolve, release: new Promise<void>((done) => { releaseListing = done; }) };
    });
    const changing = api("PUT", "/api/config", { box: { token: "box_rotated_fixture" } });
    await listingHeld;
    await control(["send", "--bot", team.ben.id, "--text", "Draft the vendor letter."]);
    await reportRan("Ben's run in its thread #Draft the vendor letter. failed");
    const duringChange = await dump(incidents);
    expect(Object.keys(duringChange.mcpConfig.mcpServers)).not.toContain("computer");
    expect(duringChange.systemPrompt).toContain("your computer could not be prepared for it (Boat account settings are being updated");
    expect((await control(["wait", "--bot", chief.id, "--task", incidents, "--timeout", "30"])).status).toBe("settled");
    releaseListing();
    await changing;

    // The machine disappears. Cara's run cannot start on it; the Chief's
    // report turn still runs, with nothing of that machine mounted, the
    // cause in front of it, and no seat on it held: Dan's run, behind it,
    // learns of the missing machine at once instead of waiting its turn.
    gone = true;
    rmSync(file(incidents, "gate"));
    await control(["send", "--bot", team.cara.id, "--text", "File the expense report."]);
    await expect.poll(async () => (await messages(incidents)).some((m) =>
      m.kind === "activity" && /^Incident: Cara's run in its thread #File the expense report\. could not start: .*cloud computer is missing/.test(m.tool?.name ?? ""),
    ), { timeout: 20_000 }).toBe(true);
    await reportRan("Cara's run in its thread #File the expense report. could not start");
    const run = await dump(incidents);
    expect(Object.keys(run.mcpConfig.mcpServers)).not.toContain("computer");
    expect(run.systemPrompt).toContain("your computer could not be prepared for it (The team's cloud computer is missing");
    expect(run.systemPrompt).not.toContain("Your team shares the cloud computer");
    await control(["send", "--bot", team.dan.id, "--text", "Book the venue."]);
    await expect.poll(async () => (await messages(team.dan.activeTaskId)).some((m) => /cloud computer is missing/.test(m.tool?.name ?? "")), { timeout: 20_000 }).toBe(true);
    expect((await messages(team.dan.activeTaskId)).some((m) => /Waiting for its turn/.test(m.tool?.name ?? ""))).toBe(false);
    writeFileSync(file(incidents, "gate"), "finish");
    await reportRan("Dan's run in its thread #Book the venue. could not start");
    expect((await control(["wait", "--bot", chief.id, "--task", incidents, "--timeout", "30"])).status).toBe("settled");
    expect((await messages(incidents)).some((m) => /could not reach|error:/.test(m.tool?.name ?? ""))).toBe(false);
  } finally {
    await close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 150_000);

it("adds no push for answering reports that waited, about failures the person already heard of", async () => {
  const { api, control, file, dump, messages, useCli, incidentsThread, pushes, close } = await launch();
  try {
    // The Chief works on Auto. Ada, Ben and Cara work on a cloud computer
    // this home has no Boat key for, so none of their runs can start — and
    // each of those already buzzes the person ("couldn't start").
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const team: Array<{ id: string; activeTaskId: string }> = [];
    for (const name of ["Ada", "Ben", "Cara"]) {
      const bot = (await control(["new-bot", "--name", name, "--section", "Ops"])).bot;
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
      team.push(bot);
    }
    await useCli('"slow"');
    const watch = await pushes();
    try {
      const cannotStart = async (bot: { id: string }, name: string, request: string, incidents?: string) => {
        await control(["send", "--bot", bot.id, "--text", request]);
        const thread = incidents ?? (await incidentsThread(chief.id)).threadId;
        await expect.poll(async () => (await messages(thread)).some((m) =>
          m.kind === "activity" && (m.tool?.name ?? "").startsWith(`Incident: ${name}'s run in its thread #${request} could not start`),
        ), { timeout: 20_000 }).toBe(true);
        return thread;
      };
      // Ada's run cannot start; the Chief takes her report at once.
      const incidents = await cannotStart(team[0], "Ada", "Reconcile the September invoices.");
      await expect.poll(async () => JSON.stringify((await dump(incidents)).prompt), { timeout: 20_000 }).toContain("Ada's run in its thread");
      // Ben's and Cara's cannot either while the Chief is still on Ada's:
      // their reports wait, and are answered together next.
      await cannotStart(team[1], "Ben", "Draft the vendor letter.", incidents);
      await cannotStart(team[2], "Cara", "File the expense report.", incidents);
      writeFileSync(file(incidents, "gate"), "finish");
      await expect.poll(async () => JSON.stringify((await dump(incidents)).prompt), { timeout: 20_000 }).toContain("Cara's run in its thread");
      expect(JSON.stringify((await dump(incidents)).prompt)).toContain("Ben's run in its thread");
      expect((await control(["wait", "--bot", chief.id, "--task", incidents, "--timeout", "30"])).status).toBe("settled");
      expect((await messages(incidents)).filter((m) => m.role === "bot" && m.kind === "text" && m.turnTerminal)).toHaveLength(2);

      // One "couldn't start" per failure, and the Chief's one "finished" for
      // the report it took at once: what reached the person when a report
      // that found the Chief busy was dropped. Answering the two that
      // waited adds nothing.
      const sent = await watch.sent(chief.id);
      expect(sent.map((push: any) => [push.kind, push.botId])).toEqual([
        ["turn-failed", team[0].id], ["turn-failed", team[1].id], ["turn-failed", team[2].id], ["done", chief.id],
      ]);
    } finally {
      watch.stream.close();
    }
  } finally {
    await close();
  }
}, 150_000);

it("keeps a report that waited quiet through the work it hands on, when the person already heard of the failure", async () => {
  const { api, control, file, dump, messages, useCli, incidentsThread, pushes, close } = await launch();
  try {
    // One thread at a time per bot: a Chief busy anywhere makes a report wait.
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const ben = (await control(["new-bot", "--name", "Ben", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${ben.id}`, { computer: "cloud" });
    const dan = (await control(["new-bot", "--name", "Dan", "--section", "Ops"])).bot;
    await useCli('"slow"');
    const watch = await pushes();
    try {
      // The person has the Chief on something of their own.
      await control(["send", "--bot", chief.id, "--text", "Plan the offsite."]);
      await dump(chief.activeTaskId);
      // Ben's run cannot start — which buzzes the person — and his report
      // waits for the Chief's slot.
      await control(["send", "--bot", ben.id, "--text", "Draft the vendor letter."]);
      const incidents = (await incidentsThread(chief.id)).threadId;
      await expect.poll(async () => (await messages(incidents)).some((m) =>
        m.kind === "activity" && (m.tool?.name ?? "").startsWith("Incident: Ben's run in its thread #Draft the vendor letter. could not start")), { timeout: 20_000 }).toBe(true);

      // The person's task ends; the report runs, and hands the work to Dan,
      // whose result comes back for review.
      writeFileSync(file(chief.activeTaskId, "gate"), "finish");
      await expect.poll(async () => JSON.stringify((await dump(incidents)).prompt), { timeout: 20_000 }).toContain("Ben's run in its thread #Draft the vendor letter. could not start");
      const token = (await dump(incidents)).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
      const handed = await api("POST", "/api/internal/coordinate-bots", { botIds: [dan.id], message: "Draft the vendor letter; Ben could not start." }, token);
      writeFileSync(file(incidents, "gate"), "finish");
      writeFileSync(file(handed.receipts[0].threadId as string, "gate"), "finish");
      await expect.poll(async () => (await messages(incidents)).some((m) =>
        m.kind === "activity" && m.tool?.name === "Resumed with Dan results, reviewing"), { timeout: 20_000 }).toBe(true);
      expect((await control(["wait", "--bot", chief.id, "--task", incidents, "--timeout", "30"])).status).toBe("settled");

      // Ben's "couldn't start" and the Chief's "finished" for the person's
      // own task — what reached the person when that report was dropped.
      // Nothing for the report, the work it handed on, or the review.
      const sent = await watch.sent(chief.id);
      expect(sent.map((push: any) => [push.kind, push.botId])).toEqual([["turn-failed", ben.id], ["done", chief.id]]);
    } finally {
      watch.stream.close();
    }
  } finally {
    await close();
  }
}, 150_000);

it("never parks a report behind work the Chief handed on, even for a Chief that parks its follow-ups", async () => {
  const { api, control, file, dump, messages, botsNow, useCli, turnEnded, incidentsThread, close } = await launch();
  try {
    // This Chief's person chose to park messages behind its teammates'
    // running work (#1194); reports are not those messages.
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, parkDirectMessages: true });
    const ada = (await control(["new-bot", "--name", "Ada", "--section", "Ops"])).bot;
    const ben = (await control(["new-bot", "--name", "Ben", "--section", "Ops"])).bot;
    const cara = (await control(["new-bot", "--name", "Cara", "--section", "Ops"])).bot;
    const dan = (await control(["new-bot", "--name", "Dan", "--section", "Ops"])).bot;
    await useCli(`${JSON.stringify([ada.activeTaskId, ben.activeTaskId, dan.activeTaskId])}.includes(thread) ? "exit-early" : "slow"`);
    const caraWorking = async () => (await botsNow()).find((bot) => bot.id === cara.id)?.busy === true;

    // Ada's run dies; from the report turn the Chief hands the work to
    // Cara, who takes her time.
    await control(["send", "--bot", ada.id, "--text", "Reconcile the September invoices."]);
    const incidents = (await incidentsThread(chief.id)).threadId;
    const token = (await dump(incidents)).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const handed = await api("POST", "/api/internal/coordinate-bots", { botIds: [cara.id], message: "Reconcile the September invoices; Ada's run crashed." }, token);
    const caraThread = handed.receipts[0].threadId as string;
    await expect.poll(caraWorking, { timeout: 20_000 }).toBe(true);

    // Ben's run dies while that report turn still runs: his report waits for
    // the thread, then runs the moment the turn ends — not when Cara does.
    await control(["send", "--bot", ben.id, "--text", "Draft the vendor letter."]);
    await expect.poll(async () => (await messages(incidents)).some((m) =>
      m.kind === "activity" && (m.tool?.name ?? "").startsWith("Incident: Ben's run")), { timeout: 20_000 }).toBe(true);
    writeFileSync(file(incidents, "gate"), "finish");
    await expect.poll(async () => JSON.stringify((await dump(incidents)).prompt), { timeout: 20_000 }).toContain("Ben's run in its thread #Draft the vendor letter. failed");
    expect(await caraWorking()).toBe(true);
    await turnEnded(chief.id, incidents);

    // Dan's dies with the thread idle and Cara still working: his report
    // starts at once.
    await control(["send", "--bot", dan.id, "--text", "Book the venue."]);
    await expect.poll(async () => JSON.stringify((await dump(incidents)).prompt), { timeout: 20_000 }).toContain("Dan's run in its thread #Book the venue. failed");
    expect(await caraWorking()).toBe(true);
    await turnEnded(chief.id, incidents);

    // Cara's result still comes back to the Chief for review.
    writeFileSync(file(caraThread, "gate"), "finish");
    await expect.poll(async () => (await messages(incidents)).some((m) =>
      m.kind === "activity" && m.tool?.name === "Resumed with Cara results, reviewing"), { timeout: 20_000 }).toBe(true);
    expect((await control(["wait", "--bot", chief.id, "--task", incidents, "--timeout", "30"])).status).toBe("settled");
  } finally {
    await close();
  }
}, 150_000);

it("tells the person of a failure whose report waited and was then refused", async () => {
  // A stand-in enterprise layer grants the monthly spend limit.
  const layerDir = mkdtempSync(join(tmpdir(), "omb-incidents-layer-"));
  mkdirSync(join(layerDir, "server"));
  writeFileSync(join(layerDir, "server", "index.js"), 'export async function register() { return { customer: "Fixture Co", features: ["budgets"], expiresAt: "2099-01-01" }; }\n');
  const { api, control, file, dump, messages, useCli, incidentsThread, pushes, close } = await launch(undefined, { dir: layerDir, licenseKey: "fixture-key" });
  try {
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const ada = (await control(["new-bot", "--name", "Ada", "--section", "Ops"])).bot;
    const ben = (await control(["new-bot", "--name", "Ben", "--section", "Ops"])).bot;
    const eve = (await control(["new-bot", "--name", "Eve"])).bot;
    await useCli(`${JSON.stringify([ada.activeTaskId, ben.activeTaskId])}.includes(thread) ? "exit-early" : thread === ${JSON.stringify(eve.activeTaskId)} ? "happy" : "slow"`);
    // Some of the month's budget is already spent.
    await control(["send", "--bot", eve.id, "--text", "hello"]);
    expect((await control(["wait", "--bot", eve.id, "--timeout", "30"])).status).toBe("settled");
    const watch = await pushes();
    try {
      // Ada's run dies and the Chief takes the report; Ben's dies meanwhile,
      // and his report waits for the Chief.
      await control(["send", "--bot", ada.id, "--text", "Reconcile the September invoices."]);
      const incidents = (await incidentsThread(chief.id)).threadId;
      await dump(incidents);
      await control(["send", "--bot", ben.id, "--text", "Draft the vendor letter."]);
      await expect.poll(async () => (await messages(incidents)).some((m) =>
        m.kind === "activity" && (m.tool?.name ?? "").startsWith("Incident: Ben's run")), { timeout: 20_000 }).toBe(true);

      // The limit is lowered below what is spent, so when Ben's report's
      // turn comes it is refused — and that is said, not swallowed: a chip
      // in the thread, and the person hears of Ben's failure, exactly as
      // for a report refused at once.
      await api("PUT", "/api/config", { budgets: { monthlyUsd: 0.005 } });
      writeFileSync(file(incidents, "gate"), "finish");
      await expect.poll(async () => (await messages(incidents)).some((m) =>
        (m.tool?.name ?? "").startsWith("error: the incident could not reach Clive — this workspace has reached its monthly spend limit")), { timeout: 20_000 }).toBe(true);
      const sent = await watch.sent(chief.id);
      expect(sent.filter((push: any) => push.kind === "incident")).toEqual([expect.objectContaining({
        botId: ben.id, threadId: ben.activeTaskId, title: "Ben hit a problem",
        body: expect.stringMatching(/^Incident: Ben's run in its thread #Draft the vendor letter\. failed/),
      })]);
      expect((await messages(incidents)).some((m) => /queued message could not start/.test(m.tool?.name ?? ""))).toBe(false);
    } finally {
      watch.stream.close();
    }
  } finally {
    await close();
    await removeTempDir(layerDir);
  }
}, 150_000);
