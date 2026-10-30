import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fixture: VerificationServer;
const evidence: unknown[] = [];
let serial = 0;
const api = (path: string, body?: unknown, method = "POST"): Promise<any> => request(path,
  body === undefined ? {} : { method, body: JSON.stringify(body) }, fixture.info.url);
const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: fixture.info.url } }) as Promise<any>;
beforeAll(async () => { fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true }); }, hostTimeout(60_000));
afterAll(async () => {
  if (!fixture) return;
  writeFileSync(fixture.info.logPath + ".simple-question-routing.json", JSON.stringify(evidence, null, 2));
  console.log("Question routing evidence:", fixture.info.logPath + ".simple-question-routing.json");
  await fixture.close();
});

it.each(["direct mention", "standing handoff", "new handoff", "one-way handoff", "open question handoff", "room mention", "room chained mention", "room handoff", "cross-room handoff"])(
  "keeps the second bot's question answerable after a %s", async (route) => {
    const suffix = ++serial;
    const lead = (await cli("new-bot", "--name", `Scout${suffix}`)).bot;
    const ledger = (await cli("new-bot", "--name", `Ledger${suffix}`)).bot;
    const roomRoute = route.includes("room");
    const room = roomRoute ? (await cli("new-channel", "--name", "Review", "--members", `${lead.id},${ledger.id}`)).channel : undefined;
    const question = `Which footer for ${route}?`;
    const arguments_ = { bot_ids: [ledger.id], message: `Check ${route}`, ...(route === "new handoff" ? { thread: "new" } : {}),
      ...(route === "one-way handoff" ? { reply: "none" } : {}), ...(route === "cross-room handoff" ? { group_id: room.id } : {}) };
    const plan = {
      [lead.id]: route === "room chained mention" ? { reply: `@${ledger.name} Please check the footer.` }
        : { steps: [{ arguments: arguments_ }], reply: "Assigned", resumeReply: "Footer checked" },
      [ledger.id]: { script: [{ key: "ask", match: [], steps: [{ server: "ogb", tool: "ask_user", arguments: { question, choices: ["Short footer", "Long footer"] }, capture: { answer: "([\\s\\S]+)" } }], reply: "I used {{answer}}" }] },
    };
    if (route === "open question handoff") {
      Object.assign(plan, {
        [lead.id]: { script: [
          { key: "assign", match: [`@${lead.name}`], steps: [{ arguments: arguments_ }], reply: "Assigned" },
          { key: "asked", match: ["stopped on a question for"], reply: "The question is ready" },
          { key: "done", match: ["Your downstream room requests have settled."], reply: "Footer checked" },
        ] },
        [ledger.id]: { script: [
          { key: "ask", match: ["Check open question handoff"], reply: `Checked.\nNEEDS INPUT: ${question}` },
          { key: "answer", match: ["The person answered:"], reply: "I used Short footer" },
        ] },
      });
    }
    const planPath = join(fixture.info.dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    const inRoom = roomRoute && route !== "cross-room handoff";
    const text = (route === "room mention" || route === "direct mention") ? `@${ledger.name} Please check the footer.` : `@${lead.name} Have ${ledger.name} check the footer.`;
    await cli(inRoom ? "send-channel" : "send", inRoom ? "--channel" : "--bot", inRoom ? room.id : lead.id, "--text", text);
    let work = "";
    let card: any;
    let state: any;
    await expect.poll(async () => {
      state = await api("/api/bots");
      const threads = roomRoute ? [room.activeTaskId] : state.bots.find((bot: any) => bot.id === ledger.id).tasks.map((task: any) => task.threadId);
      for (const threadId of threads) {
        card = (await api(`/api/threads/${threadId}/messages`)).messages.find((message: any) => message.card?.subtitle === question && !message.card.answered);
        if (card) { work = threadId; return true; }
      }
      return false;
    }, { timeout: hostTimeout(30_000) }).toBe(true);
    if (roomRoute) expect(work).toBe(room.activeTaskId);
    else {
      expect(work).not.toBe(ledger.activeTaskId);
      await expect.poll(async () => {
        state = await api("/api/bots");
        return state.bots.find((bot: any) => bot.id === ledger.id).tasks.find((task: any) => task.threadId === work).activity;
      }, { timeout: hostTimeout(10_000) }).toBe("waiting-on-you");
    }
    if (route === "open question handoff") expect(card.card.options).toEqual([]);
    const before = state;
    await api(`/api/threads/${work}/respond`, { requestId: card.card.requestId, behavior: "answer", message: "Short footer" });
    await expect.poll(async () => (await api(`/api/threads/${work}/messages`)).messages.some((message: any) => message.text === "I used Short footer"), { timeout: hostTimeout(30_000) }).toBe(true);
    if (route === "open question handoff") {
      const turns = readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(JSON.stringify(turns.find((turn) => turn.botId === ledger.id && turn.planKey === "answer")?.prompt)).toContain("Short footer");
    }
    const messages = (await api(`/api/threads/${work}/messages`)).messages;
    expect(messages.find((message: any) => message.id === card.id).card).toMatchObject({ answered: "answer", answeredText: "Short footer" });
    if (route === "direct mention") expect(readFileSync(planPath + ".evidence.jsonl", "utf8")).toContain("The user named these existing teammates");
    await expect.poll(async () => {
      const current = await api("/api/bots");
      return current.bots.every((bot: any) => !bot.busy && !bot.waitingForTeammates && bot.tasks.every((task: any) => task.activity !== "waiting-on-you")) && current.groups.every((group: any) => !group.working);
    }, { timeout: hostTimeout(30_000) }).toBe(true);
    const after = await api("/api/bots");
    if (!roomRoute) expect(after.bots.find((bot: any) => bot.id === ledger.id).tasks.find((task: any) => task.threadId === work).activity).not.toBe("waiting-on-you");
    evidence.push({ route, source: text, work, card, before, messages, after });
  }, hostTimeout(90_000));
