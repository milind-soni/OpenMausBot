// A burst end to end on the scripted engine: proposed by the bot's tool, started only by the person's press, fanned out, and merged in the parent chat.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { request } from "../../scripts/mcp-server.ts";

const PARTS = ["Acme", "Globex", "Initech"];

it("previews, runs only on Run, and writes one merged result", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const bot = (await cli("new-bot", "--name", "Researcher")).bot;
    const planPath = join(session.info.dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      [bot.id]: { script: [
        { key: "MERGE", match: ["The burst you ran"], reply: "MERGED: Acme, Globex and Initech." },
        ...PARTS.map((name) => ({ key: `PART-${name}`, match: [`This part: ${name}`], reply: `${name} was founded in 1990.` })),
        { key: "PROPOSE", match: ["BURST-JOB"], steps: [{ tool: "burst", arguments: { task: "Research companies", instructions: "Find when it was founded.", items: PARTS } }], reply: "Press Run to start." },
      ] },
    }));
    const evidence = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const lines = async () => (await api(`/api/threads/${bot.activeTaskId}/messages?limit=200`, undefined, "GET")).messages as any[];
    const card = async () => (await lines()).find((message) => message.kind === "burst")?.burst;

    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "BURST-JOB: research these three");
    await expect.poll(async () => (await card())?.phase, { timeout: 20_000 }).toBe("preview");
    const preview = await card();
    expect(preview).toMatchObject({ total: 3, requested: 3, parallel: 3, counts: { queued: 3 } });
    expect(preview.sample).toEqual(PARTS);
    expect(evidence().some((turn) => String(turn.planKey).startsWith("PART-"))).toBe(false);
    const before = (await api("/api/bots", undefined, "GET")).bots.find((one: any) => one.id === bot.id).tasks.length;

    expect(await api(`/api/bursts/${preview.burstId}/run`, {})).toMatchObject({ phase: "running", total: 3 });
    expect(await api(`/api/bursts/${preview.burstId}/run`, {}).catch((error: Error) => error.message)).toContain("already started");
    await expect.poll(async () => (await card())?.phase, { timeout: 30_000 }).toBe("done");

    const view = await api(`/api/bursts/${preview.burstId}`, undefined, "GET");
    expect(view.children.map((row: any) => row.status)).toEqual(["done", "done", "done"]);
    const bots = (await api("/api/bots", undefined, "GET")).bots.find((one: any) => one.id === bot.id).tasks as any[];
    expect(bots.length).toBe(before + 3);
    expect(bots.filter((task) => task.openedBy?.burstId === preview.burstId)).toHaveLength(3);
    for (const name of PARTS) expect(evidence().some((turn) => turn.planKey === `PART-${name}`)).toBe(true);

    const replies = (await lines()).filter((message) => message.role === "bot" && message.kind === "text").map((message) => message.text);
    expect(replies).toContain("MERGED: Acme, Globex and Initech.");
    const inbox = await api("/api/inbox", undefined, "GET");
    expect(JSON.stringify(inbox)).toContain("MERGED: Acme, Globex and Initech.");
  } finally {
    await session.close();
  }
}, 120_000);
