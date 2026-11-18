import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("rejects a misspelled start_thread recipient without creating work, then delivers the corrected handoff", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir, logPath } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const evidence: unknown[] = [];
  const cli = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: [...args, "--url", url], result });
    return result;
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const turns = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  try {
    const sender = (await cli("new-bot", "--name", "Coordinator", "--section", "Review")).bot;
    const recipient = (await cli("new-bot", "--name", "Reviewer", "--section", "Review")).bot;
    await api("PATCH", `/api/bots/${sender.id}`, { chiefOfStaff: true });
    const taskIds = async () => (await api("GET", "/api/bots")).bots
      .filter((bot: any) => [sender.id, recipient.id].includes(bot.id))
      .map((bot: any) => ({ id: bot.id, threads: bot.tasks.map((task: any) => task.threadId) }));
    const before = await taskIds();
    const title = "Review the fixture patch";
    const message = "Check the fixture patch and report the result.";
    const plans = {
      [sender.id]: { turns: [
        { steps: [{ tool: "start_thread", arguments: { bot: recipient.name, title, message }, expectError: true }], reply: "The recipient argument was refused." },
        { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [recipient.id], thread: "new", title, message, request_key: "fixture-review" } }], reply: "Sent the review." },
        { reply: "The reviewer finished." },
      ] },
      [recipient.id]: { reply: "Fixture patch reviewed." },
    };
    writeFileSync(planPath, JSON.stringify(plans));
    await cli("send", "--bot", sender.id, "--task", sender.activeTaskId, "--text", "Ask Reviewer to review the fixture patch.");
    expect((await cli("wait", "--bot", sender.id, "--task", sender.activeTaskId, "--timeout", "30")).status).toBe("settled");
    expect(await taskIds()).toEqual(before);
    const rejected = turns().find(turn => turn.botId === sender.id).evidence.find((entry: any) => entry.step?.tool === "start_thread");
    expect(rejected.response.result.isError).toBe(true);
    expect(rejected.response.result.content[0].text).toContain('unknown arguments "bot"');
    evidence.push({ rejected: rejected.response.result, tasksAfterRefusal: await taskIds() });

    await cli("send", "--bot", sender.id, "--task", sender.activeTaskId, "--text", "Use coordinate_bots to send the review.");
    await expect.poll(() => turns().find(turn => turn.botId === recipient.id), { timeout: 30_000 }).toBeTruthy();
    const recipientTurn = turns().find(turn => turn.botId === recipient.id);
    expect((await cli("wait", "--bot", recipient.id, "--task", recipientTurn.threadId, "--timeout", "30")).status).toBe("settled");
    expect((await cli("wait", "--bot", sender.id, "--task", sender.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const transcript = await cli("messages", "--bot", recipient.id, "--task", recipientTurn.threadId, "--limit", "10");
    expect(JSON.stringify(transcript)).toContain(message);
    expect(JSON.stringify(transcript)).toContain("Fixture patch reviewed.");
    const after = await taskIds();
    expect(after.find((bot: any) => bot.id === sender.id)).toEqual(before.find((bot: any) => bot.id === sender.id));
    expect(after.find((bot: any) => bot.id === recipient.id).threads).toContain(recipientTurn.threadId);
    evidence.push({ tasksAfterHandoff: after });
  } finally {
    writeFileSync(`${logPath}.log.json`, JSON.stringify({ logPath, evidence }, null, 2));
    console.log(`Start-thread routing evidence: ${logPath}.log.json`);
    await fixture.close();
  }
}, 120_000);
