import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

async function launch() {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const wire = async (botId: string) => (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === botId);
  const tasks = async (botId: string) => (await wire(botId)).tasks as any[];
  const stamps = (botId: string) => Object.fromEntries((JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as any[])
    .find((bot) => bot.id === botId).tasks.filter((task: any) => task.askedAt !== undefined).map((task: any) => [task.threadId, task.askedAt]));
  const thread = async (botId: string, title: string) => {
    await expect.poll(async () => (await tasks(botId)).some((task) => task.title === title), { timeout: 20_000 }).toBe(true);
    return (await tasks(botId)).find((task) => task.title === title);
  };
  const idle = (botId: string) => expect.poll(async () => (await tasks(botId)).some((task) => task.busy), { timeout: 20_000 }).toBe(false);
  const said = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=50`)).messages as any[])
    .map((message) => message.peerAsk ? `@${message.peerAsk.name}: ${message.text}` : message.relayed ? `relayed: ${message.text}` : message.text);
  const replied = async (botId: string, threadId: string, text: string) => {
    await expect.poll(() => said(threadId), { timeout: 20_000 }).toContain(text);
    await idle(botId);
  };
  const finished = async (find: (run: any) => boolean) => {
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find(find)?.status, { timeout: 20_000 }).toBe("completed");
    return (await api("GET", "/api/routines")).runs.find(find).threadId as string;
  };
  return { fixture, url, dataDir, api, cli, wire, tasks, stamps, thread, idle, said, replied, finished };
}

it("stamps askedAt where a person writes, never for a routine, a webhook, start_thread, a teammate's hand-off or a Slack relay", async () => {
  const { fixture, dataDir, api, cli, wire, stamps, thread, idle, said, replied, finished } = await launch();
  try {
    // One turn at a time per bot, each step settling first, so every turn meets its own scripted entry.
    await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    const { bot } = await cli("new-bot", "--name", "Asker");
    const { bot: teammate } = await cli("new-bot", "--name", "Teammate");
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
      [bot.id]: { turns: [
        { steps: [{ tool: "start_thread", arguments: { title: "Side job", message: "Check the side job." } }], reply: "Opened a side job." },
        { reply: "Side job checked." },
        { reply: "Relayed line handled." },
        { reply: "Routine report." },
        { reply: "Webhook handled." },
        { reply: "Hand-off done." },
      ] },
      [teammate.id]: { turns: [
        { steps: [{ arguments: { bot_ids: [bot.id], message: "Take this over.", thread: "new", reply: "none" } }], reply: "Handed it over." },
      ] },
    }));
    const first = bot.activeTaskId as string;
    await cli("send", "--bot", bot.id, "--task", first, "--text", "Open a side job.");
    const side = await thread(bot.id, "Side job");
    await replied(bot.id, side.threadId, "Side job checked.");
    const asked = stamps(bot.id);
    expect(asked).toEqual({ [first]: expect.any(Number) });
    expect(side.openedBy).toMatchObject({ botId: bot.id });

    // Slack's worker relays a person's line through the guarded route.
    const { task: relayed } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "From Slack", approvalMode: "ask" }, 201);
    await api("POST", `/api/bots/${bot.id}/messages/guarded`, {
      threadId: relayed.threadId, sendId: randomUUID(), text: "Sent from Slack.", expectedActiveLeafId: null,
    }, 202);
    await replied(bot.id, relayed.threadId, "Relayed line handled.");
    expect(await said(relayed.threadId)).toContain("relayed: Sent from Slack.");

    const { routine } = await api("POST", "/api/routines", {
      name: "Morning report", prompt: "Report this run's state.", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);
    const { run } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    const routineThread = await finished((candidate) => candidate.id === run.id);
    await replied(bot.id, routineThread, "Routine report.");
    expect(run.resultsThreadId).toBe(first);

    const hook = await api("POST", "/api/webhooks", { name: "Build", prompt: "Handle the build event.", botId: bot.id, runOn: "maus" }, 201);
    const delivered = await fetch(hook.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(delivered.status).toBe(202);
    const webhookThread = await finished((candidate) => candidate.webhookId === hook.webhook.id);
    await replied(bot.id, webhookThread, "Webhook handled.");

    await cli("send", "--bot", teammate.id, "--task", teammate.activeTaskId, "--text", "Hand this to Asker.");
    const handoff = await thread(bot.id, "Take this over.");
    await replied(bot.id, handoff.threadId, "Hand-off done.");
    await idle(teammate.id);
    const handed = (await api("GET", `/api/threads/${handoff.threadId}/messages?limit=50`)).messages as any[];
    expect(handed.some((message) => message.from?.botId === teammate.id && message.roomRequest?.phase === "request" && String(message.text).includes("Take this over."))).toBe(true);
    expect(handed.filter((message) => message.role === "user")).toEqual([]);
    expect(handoff.openedBy).toMatchObject({ botId: teammate.id });

    expect(stamps(bot.id)).toEqual(asked);
    const after = await wire(bot.id);
    expect(after.mainThreadId).toBe(first);
    expect(JSON.stringify(after)).not.toContain("askedAt");
  } finally {
    await fixture.close();
  }
}, 120_000);

it("moves no main thread for a teammate's work or results or a team incident; results and incidents are news where they land", async () => {
  const { fixture, dataDir, api, cli, wire, tasks, stamps, thread, idle, said, replied } = await launch();
  try {
    await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    const asker = (await cli("new-bot", "--name", "Asker", "--section", "Ops")).bot;
    const teammate = (await cli("new-bot", "--name", "Teammate", "--section", "Ops")).bot;
    const chief = (await cli("new-bot", "--name", "Chief", "--section", "Ops")).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
      [asker.id]: { script: [
        { key: "open", match: ["Open a side job that asks Teammate."],
          steps: [{ tool: "start_thread", arguments: { title: "Side job", message: "Ask Teammate to check the books." } }], reply: "Opened a side job." },
        { key: "ask", match: ["Ask Teammate to check the books."], steps: [{ arguments: { bot_ids: [teammate.id], message: "BOOKS: check the books." } }], reply: "Asked Teammate." },
        { key: "review", match: ["Your downstream room requests have settled."], reply: "Side job done: the books balance." },
      ] },
      [teammate.id]: { script: [
        { key: "books", match: ["BOOKS: check the books."], reply: "The books balance." },
        { key: "crash", match: ["Reconcile the invoices."], fail: true },
      ] },
      [chief.id]: { script: [{ key: "incident", match: ["incident report"], reply: "Incident noted." }] },
    }));

    await cli("send", "--bot", asker.id, "--task", asker.activeTaskId, "--text", "Open a side job that asks Teammate.");
    const side = await thread(asker.id, "Side job");
    await replied(asker.id, side.threadId, "Side job done: the books balance.");
    const work = (await tasks(teammate.id)).find((task) => task.openedBy?.kind === "work");
    expect(await said(work.threadId)).toContain("The books balance.");
    await idle(teammate.id);

    await cli("send", "--bot", teammate.id, "--task", teammate.activeTaskId, "--text", "Reconcile the invoices.");
    const incidents = await thread(chief.id, "Problems to look at");
    await replied(chief.id, incidents.threadId, "Incident noted.");

    expect(Object.keys(stamps(asker.id))).toEqual([asker.activeTaskId]);
    expect(Object.keys(stamps(teammate.id))).toEqual([teammate.activeTaskId]);
    expect(stamps(chief.id)).toEqual({});
    expect((await wire(asker.id)).mainThreadId).toBe(asker.activeTaskId);
    expect((await wire(teammate.id)).mainThreadId).toBe(teammate.activeTaskId);
    expect((await wire(chief.id)).mainThreadId).toBe(chief.activeTaskId);
    expect((await tasks(asker.id)).find((task) => task.threadId === side.threadId).unread).toBe(true);
    expect((await tasks(chief.id)).find((task) => task.threadId === incidents.threadId).unread).toBe(true);
  } finally {
    await fixture.close();
  }
}, 120_000);

it("marks a job's review answer and a webhook post unread where they land", async () => {
  const { fixture, dataDir, api, cli, tasks, replied } = await launch();
  try {
    const asker = (await cli("new-bot", "--name", "Asker", "--section", "Ops")).bot;
    const teammate = (await cli("new-bot", "--name", "Teammate", "--section", "Ops")).bot;
    const gate = join(dataDir, "review.gate");
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
      [asker.id]: { script: [
        { key: "ask", match: ["Ask Teammate to check the books."], steps: [{ arguments: { bot_ids: [teammate.id], message: "BOOKS: check the books." } }], reply: "Asked Teammate." },
        { key: "review", match: ["Your downstream room requests have settled."], gateFile: gate, reply: "Reviewed: the books balance." },
      ] },
      [teammate.id]: { script: [{ key: "books", match: ["BOOKS: check the books."], reply: "The books balance." }] },
    }));
    const unread = async (botId: string, threadId: string) => (await tasks(botId)).find((task) => task.threadId === threadId)?.unread;
    await cli("send", "--bot", asker.id, "--task", asker.activeTaskId, "--text", "Ask Teammate to check the books.");
    await expect.poll(async () => ((await api("GET", `/api/threads/${asker.activeTaskId}/messages?limit=50`)).messages as any[])
      .some((message) => message.tool?.name?.startsWith("Resumed with Teammate results")), { timeout: 20_000 }).toBe(true);
    await api("POST", `/api/bots/${asker.id}/read`, { threadId: asker.activeTaskId });
    expect(await unread(asker.id, asker.activeTaskId)).toBe(false);
    writeFileSync(gate, "open");
    await replied(asker.id, asker.activeTaskId, "Reviewed: the books balance.");
    expect(await unread(asker.id, asker.activeTaskId)).toBe(true);

    const hook = await api("POST", "/api/webhooks", { name: "Deploys", prompt: "", botId: asker.id, delivery: "post" }, 201);
    const delivered = await fetch(hook.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Deploy finished." }) });
    expect(delivered.ok).toBe(true);
    await expect.poll(async () => (await tasks(asker.id)).find((task) => task.title === "Updates")?.unread, { timeout: 20_000 }).toBe(true);
  } finally {
    await fixture.close();
  }
}, 120_000);
