import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

// Check before done through the real wiring: the person's answer goes to the named checker, its issues come back as a
// fix in the same conversation, and the conversation ends on the fixed answer and one line saying it was checked.

it("checks a finished answer with the named bot, has the issues fixed, and ends on the fixed answer with one checked line; off, nothing changes", async () => {
  const session = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const worker = (await cli("new-bot", "--name", "Nib")).bot;
    const checker = (await cli("new-bot", "--name", "Vera")).bot;
    const plain = (await cli("new-bot", "--name", "Plain")).bot;
    const planPath = join(session.info.dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      [worker.id]: { script: [
        { key: "first", match: ["Improve the dialogue"], reply: "She left at dusk. \"Goodbye,\" she said." },
        { key: "fix", match: ["Fix exactly these and nothing else"], reply: "She left at dawn. \"Goodbye,\" she said.\n\nChanged: dusk to dawn." },
      ] },
      [checker.id]: { script: [
        { key: "r1", match: ["round 1 of 3", "She left at dusk"], reply: "issues: 1\n1. Line 1: the source says dawn; the result says dusk. Fix: dawn." },
        { key: "r2", match: ["round 2 of 3", "She left at dawn"], reply: "pass" },
      ] },
      [plain.id]: { reply: "Plain answer." },
    }));
    const turns = () => existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages as any[];

    for (const refused of [{ checker: worker.id }, { checker: "no-such-bot" }, { checker: checker.id, rounds: 9 }, true]) {
      await expect(api(`/api/bots/${worker.id}`, { checkWork: refused }, "PATCH")).rejects.toThrow(/checkWork/);
    }
    expect((await api(`/api/bots/${worker.id}`, { checkWork: { checker: checker.id } }, "PATCH")).bot.checkWork).toEqual({ checker: checker.id });

    await cli("send", "--bot", worker.id, "--task", worker.activeTaskId, "--text", "Improve the dialogue in this scene. The source says she left at dawn.");
    await expect.poll(async () => (await messages(worker.activeTaskId)).some((message) => message.tool?.name?.startsWith("Checked by")), { timeout: 60_000, interval: 250 }).toBe(true);
    const chat = await messages(worker.activeTaskId);
    const shown = chat.filter((message) => message.role === "bot" && (message.kind === "text" || message.kind === "activity")).map((message) => message.kind === "text" ? message.text : message.tool.name);
    expect(shown.slice(-4)).toEqual([
      "She left at dusk. \"Goodbye,\" she said.",
      "Vera found 1 issue · fixing it, round 1 of 3",
      "She left at dawn. \"Goodbye,\" she said.\n\nChanged: dusk to dawn.",
      "Checked by Vera · passed in round 2",
    ]);
    const line = chat.at(-1);
    expect(line.tool).toMatchObject({ ok: true, input: "Vera · round 2 of 3", output: "pass" });
    // The fix is the harness's request, never a line the person wrote.
    expect(chat.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["Improve the dialogue in this scene. The source says she left at dawn."]);
    const checks = turns().filter((turn) => turn.botId === checker.id);
    expect(checks).toHaveLength(2);
    expect(JSON.stringify(checks[0].prompt)).toContain("Improve the dialogue in this scene. The source says she left at dawn.");
    expect(new Set(checks.map((turn) => turn.threadId)).has(worker.activeTaskId)).toBe(false);

    await cli("send", "--bot", plain.id, "--task", plain.activeTaskId, "--text", "Improve the dialogue, please.");
    expect((await cli("wait", "--bot", plain.id, "--task", plain.activeTaskId, "--timeout", "30")).status).toBe("settled");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const untouched = await messages(plain.activeTaskId);
    expect(untouched.filter((message) => message.kind === "activity" && /Checked|Not checked|found/.test(message.tool?.name ?? ""))).toEqual([]);
    expect(turns().filter((turn) => turn.botId === plain.id)).toHaveLength(1);
  } finally { await session.close(); }
}, 120_000);
