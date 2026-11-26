import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { readRegistry } from "./testing/registry.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

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
  const stamps = (botId: string) => Object.fromEntries((readRegistry(dataDir).bots as any[])
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

it("keeps the main thread an install already had across an update, then moves it only when the person does or archives it", async () => {
  const server = await launchRestartableServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${server.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", server.url]) as Promise<any>;
  try {
    const { bot } = await cli("new-bot", "--name", "Keeper");
    const first = bot.activeTaskId as string;
    const main = async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id).mainThreadId;
    const open = async (title: string) => (await api("POST", `/api/bots/${bot.id}/tasks`, { title, approvalMode: "ask" }, 201)).task.threadId as string;
    const write = async (threadId: string) => {
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", "Note this.");
      await expect.poll(async () => ((await api("GET", `/api/threads/${threadId}/messages?limit=50`)).messages as any[]).some((message) => message.role !== "user"), { timeout: 20_000 }).toBe(true);
      await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id).busy, { timeout: 20_000 }).toBe(false);
    };
    const saved = () => readRegistry(server.dataDir).bots.find((candidate: any) => candidate.id === bot.id);
    const second = await open("Second");
    const third = await open("Third");
    await write(second);

    // What an install saved before a main thread was kept: threads stamped where the person wrote, and no choice.
    await server.stop();
    const file = join(server.dataDir, "bots.json");
    writeFileSync(file, JSON.stringify((JSON.parse(readFileSync(file, "utf8")) as any[]).map(({ mainThreadChoice: _choice, mainThreadKept: _kept, ...rest }) => rest)));
    expect(saved().tasks.find((task: any) => task.threadId === second).askedAt).toEqual(expect.any(Number));
    await server.start();
    expect(await main(), "the thread the person last wrote in, as before the update").toBe(second);
    await write(third);
    expect(await main()).toBe(second);
    await server.stop();
    expect(saved()).toMatchObject({ mainThreadKept: { id: second } });
    expect(saved().mainThreadChoice).toBeUndefined();
    await server.start();
    expect(await main()).toBe(second);

    await api("PATCH", `/api/bots/${bot.id}/tasks/${second}`, { archivedAt: Date.now() });
    expect(await main(), "the oldest open conversation the person started takes over").toBe(first);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${second}`, { archivedAt: null });
    await write(second);
    expect(await main(), "reopening the old main thread moves nothing").toBe(first);

    await api("PATCH", `/api/bots/${bot.id}`, { mainThreadChoice: third });
    expect(await main()).toBe(third);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${third}`, { archivedAt: Date.now() });
    expect(await main()).toBe(first);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${third}`, { archivedAt: null });
    expect(await main()).toBe(first);
    await api("DELETE", `/api/bots/${bot.id}/tasks/${first}`);
    expect(await main(), "deleting it moves it once more").toBe(second);
  } finally {
    await server.close();
  }
}, 180_000);

it("keeps the selected thread as the main one across an update for a bot nobody wrote to", async () => {
  const server = await launchRestartableServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${server.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Quiet", "--url", server.url]) as any;
    const first = bot.activeTaskId as string;
    const main = async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id).mainThreadId;
    const saved = () => readRegistry(server.dataDir).bots.find((candidate: any) => candidate.id === bot.id);
    const second = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Second", approvalMode: "ask" }, 201)).task.threadId as string;

    // What an install saved before a main thread was kept: no choice, the second thread selected, nothing written anywhere.
    await server.stop();
    const file = join(server.dataDir, "bots.json");
    writeFileSync(file, JSON.stringify((JSON.parse(readFileSync(file, "utf8")) as any[]).map(({ mainThreadChoice: _choice, mainThreadKept: _kept, ...rest }) => rest)));
    expect(saved()).toMatchObject({ threadId: second });
    expect(saved().tasks.some((task: any) => task.askedAt !== undefined)).toBe(false);
    await server.start();
    expect(await main(), "the selected thread, as before the update").toBe(second);
    await api("POST", `/api/bots/${bot.id}/tasks/${first}`);
    expect((await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id).threadId).toBe(first);
    expect(await main(), "selecting another thread moves nothing").toBe(second);
    await server.stop();
    expect(saved()).toMatchObject({ mainThreadKept: { id: second } });
    expect(saved().mainThreadChoice).toBeUndefined();
    await server.start();
    expect(await main()).toBe(second);
  } finally {
    await server.close();
  }
}, 120_000);

it("moves an archived or deleted main thread to the only open one, a thread the bot opened, and keeps it there", async () => {
  const { fixture, dataDir, api, cli, wire, thread, replied } = await launch();
  try {
    const { bot } = await cli("new-bot", "--name", "Keeper");
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
      [bot.id]: { turns: [
        { steps: [{ tool: "start_thread", arguments: { title: "Side job", message: "Check the side job." } }], reply: "Opened a side job." },
        { reply: "Side job checked." },
      ] },
    }));
    const first = bot.activeTaskId as string;
    await cli("send", "--bot", bot.id, "--task", first, "--text", "Open a side job.");
    const side = await thread(bot.id, "Side job");
    await replied(bot.id, side.threadId, "Side job checked.");
    expect(side.openedBy).toMatchObject({ botId: bot.id });
    const main = async () => (await wire(bot.id)).mainThreadId;
    const open = async (title: string) => (await api("POST", `/api/bots/${bot.id}/tasks`, { title, approvalMode: "ask" }, 201)).task.threadId as string;

    await api("PATCH", `/api/bots/${bot.id}`, { mainThreadChoice: first });
    expect(await main()).toBe(first);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${first}`, { archivedAt: Date.now() });
    expect(await main(), "the thread the bot opened is the only one open").toBe(side.threadId);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${first}`, { archivedAt: null });
    expect(await main(), "reopening the old main thread moves nothing").toBe(side.threadId);

    await api("PATCH", `/api/bots/${bot.id}`, { mainThreadChoice: first });
    expect(await main()).toBe(first);
    await api("DELETE", `/api/bots/${bot.id}/tasks/${first}`);
    expect(await main()).toBe(side.threadId);
    await open("Later");
    expect(await main(), "a thread the person opens afterwards moves nothing").toBe(side.threadId);
  } finally {
    await fixture.close();
  }
}, 120_000);

it("leaves an install's memory where it was when the update saves its main thread, and moves it only with the person's own choice", async () => {
  const server = await launchRestartableServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${server.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", server.url]) as Promise<any>;
  try {
    const { bot } = await cli("new-bot", "--name", "Counsel");
    const oldest = bot.activeTaskId as string;
    const main = async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id).mainThreadId;
    const ownNotes = async (threadId: string) => (await api("GET", `/api/bots/${bot.id}/memory/thread/${threadId}`)).scoped as boolean;
    const saved = () => readRegistry(server.dataDir).bots.find((candidate: any) => candidate.id === bot.id);
    const written = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Acme NDA", approvalMode: "ask" }, 201)).task.threadId as string;
    await cli("send", "--bot", bot.id, "--task", written, "--text", "Note this.");
    await expect.poll(async () => ((await api("GET", `/api/threads/${written}/messages?limit=50`)).messages as any[]).some((message) => message.role !== "user"), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id).busy, { timeout: 20_000 }).toBe(false);

    // What an install saved before a main thread was kept: no choice, so the oldest conversation held the bot's memory.
    await server.stop();
    const file = join(server.dataDir, "bots.json");
    writeFileSync(file, JSON.stringify((JSON.parse(readFileSync(file, "utf8")) as any[]).map(({ mainThreadChoice: _choice, mainThreadKept: _kept, ...rest }) => rest)));
    await server.start();
    expect(await main(), "the thread the person last wrote in, as before the update").toBe(written);
    expect([await ownNotes(oldest), await ownNotes(written)], "the oldest conversation still holds the bot's memory").toEqual([false, true]);
    await api("POST", `/api/bots/${bot.id}/tasks/${oldest}`);
    await server.stop();
    expect(saved()).toMatchObject({ mainThreadKept: { id: written } });
    expect(saved().mainThreadChoice).toBeUndefined();
    await server.start();
    expect([await main(), await ownNotes(oldest), await ownNotes(written)]).toEqual([written, false, true]);

    await api("PATCH", `/api/bots/${bot.id}`, { mainThreadChoice: written });
    expect([await main(), await ownNotes(oldest), await ownNotes(written)], "the person's choice takes the bot's memory, as it did").toEqual([written, true, false]);
    await server.stop();
    expect(saved()).toMatchObject({ mainThreadChoice: written });
    expect(saved().mainThreadKept).toBeUndefined();
  } finally {
    await server.close();
  }
}, 180_000);

it("shows the main thread the person chose in an older version, not the one saved for them before that", async () => {
  const server = await launchRestartableServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${server.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", server.url]) as Promise<any>;
  try {
    const { bot } = await cli("new-bot", "--name", "Returner");
    const oldest = bot.activeTaskId as string;
    const main = async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id).mainThreadId;
    const saved = () => readRegistry(server.dataDir).bots.find((candidate: any) => candidate.id === bot.id);
    const file = join(server.dataDir, "bots.json");
    const rewrite = (change: (record: any) => any) => writeFileSync(file, JSON.stringify((JSON.parse(readFileSync(file, "utf8")) as any[]).map(change)));
    const written = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Written", approvalMode: "ask" }, 201)).task.threadId as string;
    const bystander = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Bystander", approvalMode: "ask" }, 201)).task.threadId as string;
    await cli("send", "--bot", bot.id, "--task", written, "--text", "Note this.");
    await expect.poll(async () => ((await api("GET", `/api/threads/${written}/messages?limit=50`)).messages as any[]).some((message) => message.role !== "user"), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id).busy, { timeout: 20_000 }).toBe(false);

    await server.stop();
    rewrite(({ mainThreadChoice: _choice, mainThreadKept: _kept, ...rest }) => rest);
    await server.start();
    expect(await main()).toBe(written);
    await api("POST", `/api/bots/${bot.id}/tasks/${oldest}`);
    await server.stop();
    expect(saved().mainThreadKept).toEqual({ id: written });

    // An older version knows only mainThreadChoice: the person's pick there leaves the thread saved for them on disk.
    rewrite((record) => ({ ...record, mainThreadChoice: oldest }));
    await server.start();
    expect(await main(), "the person's later choice").toBe(oldest);

    await api("PATCH", `/api/bots/${bot.id}/tasks/${oldest}`, { archivedAt: Date.now() });
    expect(await main(), "the oldest open conversation takes over").toBe(written);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${oldest}`, { archivedAt: null });
    expect(await main(), "reopening the choice moves nothing").toBe(written);
    await api("POST", `/api/bots/${bot.id}/tasks/${bystander}`);
    await server.stop();
    expect(saved()).toMatchObject({ mainThreadChoice: oldest, mainThreadKept: { id: written, under: oldest } });
    await server.start();
    expect(await main()).toBe(written);

    // The older version again, clearing the choice: the substitute was kept under a choice that is gone.
    await server.stop();
    rewrite(({ mainThreadChoice: _choice, ...rest }) => rest);
    await server.start();
    expect(await main(), "what a bot with no choice shows: the conversation the person last wrote in").toBe(written);
  } finally {
    await server.close();
  }
}, 180_000);

it("drops the thread saved for a bot once an older version chooses another, so clearing that choice does not bring it back", async () => {
  const server = await launchRestartableServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${server.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", server.url]) as Promise<any>;
  try {
    const { bot } = await cli("new-bot", "--name", "Switcher");
    const chosen = bot.activeTaskId as string;
    const main = async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id).mainThreadId;
    const saved = () => readRegistry(server.dataDir).bots.find((candidate: any) => candidate.id === bot.id);
    const file = join(server.dataDir, "bots.json");
    const rewrite = (change: (record: any) => any) => writeFileSync(file, JSON.stringify((JSON.parse(readFileSync(file, "utf8")) as any[]).map(change)));
    const writeIn = async (threadId: string) => {
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", "Note this.");
      await expect.poll(async () => ((await api("GET", `/api/threads/${threadId}/messages?limit=50`)).messages as any[]).some((message) => message.role !== "user"), { timeout: 20_000 }).toBe(true);
      await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id).busy, { timeout: 20_000 }).toBe(false);
    };
    const kept = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Kept", approvalMode: "ask" }, 201)).task.threadId as string;
    const later = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Later", approvalMode: "ask" }, 201)).task.threadId as string;
    await writeIn(kept);

    await server.stop();
    rewrite(({ mainThreadChoice: _choice, mainThreadKept: _kept, ...rest }) => rest);
    await server.start();
    expect(await main()).toBe(kept);
    await api("POST", `/api/bots/${bot.id}/tasks/${chosen}`);
    await server.stop();
    expect(saved().mainThreadKept).toEqual({ id: kept });

    // An older version knows only mainThreadChoice: the person picks another thread there.
    rewrite((record) => ({ ...record, mainThreadChoice: chosen }));
    await server.start();
    expect(await main(), "the person's later choice").toBe(chosen);
    await writeIn(later);
    await server.stop();
    expect(saved().mainThreadKept, "the thread kept under no choice is gone from disk").toBeUndefined();

    // The older version again, clearing the choice.
    rewrite(({ mainThreadChoice: _choice, ...rest }) => rest);
    await server.start();
    expect(await main(), "what a bot with no choice shows: the conversation the person last wrote in").toBe(later);
  } finally {
    await server.close();
  }
}, 180_000);
