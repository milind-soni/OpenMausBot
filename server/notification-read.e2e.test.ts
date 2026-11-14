import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { openSse } from "./testing/sse.ts";

it("opening a conversation reads its notifications in the feed and tells every open app, leaving other conversations' alone", async () => {
  const fixture = await launchVerificationServer();
  const { url } = fixture.info;
  const stream = await openSse(`${url}/api/events`, { origin: url });
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const notifications = async () => (await api("GET", "/api/notifications")).notifications as any[];
  const answered = async (name: string) => {
    const { bot } = await runControlOmb(["new-bot", "--name", name, "--url", url]) as any;
    const threadId = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id).threadId as string;
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "Summarize the queue." }, 202);
    await expect.poll(async () => (await notifications()).some((entry) => entry.threadId === threadId && !entry.read), { timeout: 30_000 }).toBe(true);
    return { botId: bot.id as string, threadId };
  };
  try {
    const opened = await answered("Infra");
    const other = await answered("Sales");
    const openedIds = (await notifications()).filter((entry) => entry.threadId === opened.threadId).map((entry) => entry.id);

    await api("POST", `/api/bots/${opened.botId}/read`, { threadId: opened.threadId });
    const frame = await stream.until((candidate) => candidate.kind === "notifications.read" && candidate.threadId === opened.threadId, 10_000);
    expect(frame.ids).toEqual(openedIds);
    const after = await notifications();
    expect(after.filter((entry) => entry.threadId === opened.threadId).every((entry) => entry.read)).toBe(true);
    expect(after.filter((entry) => entry.threadId === other.threadId).some((entry) => !entry.read)).toBe(true);

    await api("POST", `/api/bots/${opened.botId}/read`, { threadId: opened.threadId });
    await api("PATCH", `/api/bots/${other.botId}`, { name: "Sales desk" });
    await stream.until((candidate) => candidate.kind === "bot" && candidate.bot?.name === "Sales desk", 10_000);
    expect(stream.frames.filter((candidate) => candidate.kind === "notifications.read")).toHaveLength(1);

    // switching to a conversation opens it too
    await api("POST", `/api/bots/${other.botId}/tasks/${other.threadId}?messages=0`);
    await stream.until((candidate) => candidate.kind === "notifications.read" && candidate.threadId === other.threadId, 10_000);
    expect((await notifications()).every((entry) => entry.read)).toBe(true);
  } finally {
    stream.close();
    await fixture.close();
  }
}, 90_000);
