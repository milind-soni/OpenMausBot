// Real server, injected MCP proxy, durable confirmation and scheduler records.
// The scripted provider chooses known expressions; this is not a model-quality test.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { nextCronRuns } from "../shared/routine-schedule.ts";

it("takes cron through the real routine tools and confirmation, preserving its zone and rejecting invalid API input", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const providerEvidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    : [];
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result: value });
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    expect((await cli("doctor")).ok).toBe(true);
    const { bot } = await cli("new-bot", "--name", "Cron fixture");
    const threadId = bot.activeTaskId;
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
    const proposal = async (tool: string, args: unknown, text: string, expectError = false) => {
      const previousTurns = providerEvidence().length;
      writeFileSync(planPath, JSON.stringify({ [bot.id]: {
        expectSystemIncludes: ["five-field cron expression", "Never replace a calendar rule with daily AI date checking", "including its VPS"],
        steps: [{ tool: "list_routines", arguments: {} }, { tool, arguments: args, expectError }],
        reply: expectError ? "That invalid schedule was refused." : "Please review the routine confirmation.",
      } }));
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
      await expect.poll(() => providerEvidence().length, { timeout: 20_000 }).toBe(previousTurns + 1);
      await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "20");
      const turn = providerEvidence().at(-1);
      const toolResponse = turn.evidence.find((entry: any) => entry.step?.tool === tool).response;
      expect(toolResponse.error).toBeUndefined();
      expect(Boolean(toolResponse.result.isError)).toBe(expectError);
      evidence.push({ turn });
      return (await messages()).findLast(message => message.card?.routineRequest && !message.card.answered)?.card;
    };
    const confirm = async (card: any) => {
      expect(card?.requestId).toBeTruthy();
      const result = await api("POST", `/api/bots/${bot.id}/respond`, { threadId, requestId: card.requestId, behavior: "allow" });
      expect(result.outcome).toBe("allowed-once");
      expect((await messages()).find(message => message.card?.requestId === card.requestId)?.card.answered).toBe("allow");
      return result;
    };
    const schedule = { type: "cron" as const, expression: "0 9 1 * *", timeZone: "America/New_York" };
    const create = await proposal("propose_routine", {
      name: "Monthly report", instructions: "Summarize last month's fixture activity; no external services.", schedule, overlap: "queue",
    }, "Schedule a report at 9am New York time on the first of each month.");
    expect((await api("GET", "/api/routines")).routines).toHaveLength(0);
    expect(create.routineRequest).toMatchObject({ version: 1, operation: { action: "create", routine: { schedule } } });
    expect(create.subtitle).toContain("Next 3 runs (America/New_York)");
    expect(create.subtitle).toContain("Cron: 0 9 1 * *");
    const { resultId: routineId } = await confirm(create);
    const current = async () => (await api("GET", "/api/routines")).routines.find((routine: any) => routine.id === routineId);
    expect(await current()).toMatchObject({ schedule, enabled: true, runOn: "maus", overlap: "queue" });
    expect(create.subtitle).toContain("Queue one scheduled run");
    expect((await current()).nextRunAt).toBe(nextCronRuns(schedule, create.routineRequest.createdAt, 1)[0]);

    const cardCount = (await messages()).filter(message => message.card?.routineRequest).length;
    await proposal("propose_routine", {
      name: "Renamed monthly report", instructions: "Summarize last month's fixture activity; no external services.", schedule, overlap: "queue",
    }, "Try scheduling the same work again under a different name.", true);
    const duplicateResponse = providerEvidence().at(-1).evidence.find((entry: any) => entry.step?.tool === "propose_routine").response;
    expect(duplicateResponse.result.content[0].text).toContain(routineId);
    expect(duplicateResponse.result.content[0].text).toContain("already exists");
    expect((await messages()).filter(message => message.card?.routineRequest)).toHaveLength(cardCount);
    expect((await api("GET", "/api/routines")).routines).toHaveLength(1);

    const lastDay = { ...schedule, expression: "0 9 L * *" };
    const update = await proposal("propose_routine_action", {
      action: "update", routine_id: routineId, changes: { schedule: lastDay, overlap: "skip" },
    }, "Change that report to the last day of each month at the same time and zone.");
    const listed = providerEvidence().at(-1).evidence.find((entry: any) => entry.step?.tool === "list_routines").response.result.content[0].text;
    expect(listed).toContain('"type": "cron"');
    expect(listed).toContain('"timeZone": "America/New_York"');
    expect(listed).toContain('"overlap": "queue"');
    expect(listed).toContain('"failureStreak": 0');
    expect((await current()).schedule).toEqual(schedule);
    await confirm(update);
    expect((await current()).schedule).toEqual(lastDay);
    expect((await current()).overlap).toBeUndefined();
    const pause = await proposal("propose_routine_action", { action: "pause", routine_id: routineId }, "Pause the monthly report.");
    expect((await current()).enabled).toBe(true);
    await confirm(pause);
    expect(await current()).toMatchObject({ enabled: false, nextRunAt: null, schedule: lastDay });
    const resume = await proposal("propose_routine_action", { action: "resume", routine_id: routineId }, "Resume the monthly report.");
    expect(resume.subtitle).toContain("Next 3 runs (America/New_York)");
    await confirm(resume);
    expect(await current()).toMatchObject({ enabled: true, schedule: lastDay });

    await proposal("propose_routine", { name: "Impossible date", instructions: "Must not run.", schedule: { ...schedule, expression: "0 9 31 2 *" } }, "Try an invalid calendar rule.", true);
    await proposal("propose_routine", {
      name: "Explicit Box", instructions: "Run on the Box-hosted agent.", schedule, run_on: "box",
    }, "Try the separate Box runner without a Box account.", true);
    const boxResponse = providerEvidence().at(-1).evidence.find((entry: any) => entry.step?.tool === "propose_routine").response;
    expect(boxResponse.result.content[0].text).toContain('run_on="maus"');
    expect(boxResponse.result.content[0].text).toContain("self-hosted VPS");
    const before = await current();
    for (const invalid of [
      { type: "cron", expression: "0 9 1 * *" },
      { ...schedule, timeZone: "Not/AZone" },
      { ...schedule, expression: "0 0 9 1 * *" },
      { ...schedule, expression: "0 9 31 2 *" },
    ]) {
      await api("POST", "/api/routines", { botId: bot.id, name: "Invalid", prompt: "Must not persist", schedule: invalid }, 400);
      await api("PATCH", `/api/routines/${routineId}`, { schedule: invalid }, 400);
    }
    expect(await current()).toEqual(before);
    expect((await api("GET", "/api/routines")).routines).toHaveLength(1);
    const persisted = JSON.parse(readFileSync(join(fixture.info.dataDir, "routines.json"), "utf8"));
    expect(persisted.routines.find((routine: any) => routine.id === routineId).schedule).toEqual(lastDay);
    evidence.push({ final: await api("GET", "/api/routines"), persisted });
  } finally {
    const evidencePath = `${fixture.info.logPath}.cron.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 90_000);
