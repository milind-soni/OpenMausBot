import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("opens each run of a routine with its own model in the run's thread, and refuses a model it cannot check", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const { bot } = await cli("new-bot", "--name", "Routine model fixture");
    const own = { instanceId: bot.modelSelection.instanceId, model: `${bot.modelSelection.model}-routine` };
    const created = await api("POST", "/api/routines", { name: "Inbox sweep", prompt: "Sweep the inbox", botId: bot.id,
      schedule: { type: "daily", time: "09:00", weekdays: [1] }, modelSelection: own });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.routine.modelSelection).toEqual(own);
    const run = (await api("POST", `/api/routines/${created.body.routine.id}/run`)).body.run;
    await expect.poll(async () => (await api("GET", "/api/routines")).body.runs.find((item: any) => item.id === run.id)?.threadId,
      { timeout: 20_000 }).toBeTruthy();
    const threadId = (await api("GET", "/api/routines")).body.runs.find((item: any) => item.id === run.id).threadId;
    const task = (await api("GET", "/api/bots")).body.bots.find((each: any) => each.id === bot.id).tasks.find((item: any) => item.threadId === threadId);
    expect(task.modelSelection).toEqual(own);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 30_000 }).toBe(true);
    const { argv } = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { argv: string[] };
    expect(argv[argv.indexOf("--model") + 1]).toBe(own.model);
    const refused = await api("POST", "/api/routines", { name: "Inbox sweep", prompt: "Sweep the inbox", botId: bot.id,
      schedule: { type: "daily", time: "09:00", weekdays: [1] }, modelSelection: { instanceId: own.instanceId, model: own.model, effort: "galaxy" } });
    expect(refused).toMatchObject({ status: 400, body: { error: 'effort "galaxy" is not recognized' } });
  } finally {
    await fixture.close();
  }
}, 120_000);
