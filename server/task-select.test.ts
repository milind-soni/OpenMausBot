import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("creating a chat without selecting it", () => {
  let fixture: VerificationServer;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };

  beforeAll(async () => {
    fixture = await launchVerificationServer();
  }, 90_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("creates a chat without switching the bot's open chat when select is false", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Select fixture" })).body.bot;
    const created = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Quick asks", select: false });
    expect(created.status).toBe(201);
    expect(created.body.task.title).toBe("Quick asks");
    const after = (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id);
    expect(after.threadId).toBe(bot.threadId);
    expect(after.tasks.map((t: any) => t.threadId)).toContain(created.body.task.threadId);
  });

  it("still selects a new chat by default", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Default select" })).body.bot;
    const created = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Picked" });
    expect((await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).threadId).toBe(created.body.task.threadId);
  });

  it("refuses a select that is not a boolean", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Bad select" })).body.bot;
    expect(await api("POST", `/api/bots/${bot.id}/tasks`, { select: "no" })).toEqual({ status: 400, body: { error: "select must be a boolean" } });
  });
});
