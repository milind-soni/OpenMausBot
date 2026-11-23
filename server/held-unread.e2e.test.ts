import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { openSse } from "./testing/sse.ts";

it("holds a conversation marked unread with it open against being on screen, in every window, until it is opened or answered", async () => {
  const fixture = await launchVerificationServer();
  const { url } = fixture.info;
  const otherWindow = await openSse(`${url}/api/events`, { origin: url });
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  try {
    const { bot: created } = await runControlOmb(["new-bot", "--name", "Infra", "--url", url]) as any;
    const botId = created.id as string;
    const reloaded = async () => ((await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === botId)).tasks
      .find((task: any) => task.threadId === threadId) as { unread?: boolean; heldUnread?: string };
    const threadId = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === botId).threadId as string;
    const answered = async (text: string) => {
      await api("POST", `/api/bots/${botId}/messages`, { threadId, text }, 202);
      await expect.poll(async () => (await reloaded()).unread, { timeout: 30_000 }).toBe(true);
    };
    const mark = async () => {
      const before = otherWindow.frames.length;
      await api("PATCH", `/api/bots/${botId}`, { unread: true });
      const held = await otherWindow.until((frame) => otherWindow.frames.indexOf(frame) >= before && frame.kind === "bot" && frame.bot?.id === botId &&
        frame.bot.tasks?.some((task: any) => task.threadId === threadId && task.heldUnread !== undefined), 10_000);
      const states = otherWindow.frames.slice(before, otherWindow.frames.indexOf(held) + 1)
        .filter((frame) => frame.kind === "bot" && frame.bot?.id === botId)
        .map((frame) => frame.bot.tasks?.find((task: any) => task.threadId === threadId))
        .map((task) => ({ unread: task?.unread === true, held: task?.heldUnread !== undefined }));
      expect(states, "never told unread without its mark").not.toContainEqual({ unread: true, held: false });
      return held.bot.tasks.find((task: any) => task.threadId === threadId);
    };
    await answered("Summarize the queue.");
    await api("POST", `/api/bots/${botId}/read`, { threadId });

    const told = await mark();
    expect(told, "another window is told").toMatchObject({ unread: true });
    expect(await reloaded(), "a reloaded page reads the same").toMatchObject({ unread: true, heldUnread: told.heldUnread });
    await api("POST", `/api/bots/${botId}/read`, { threadId, reason: "seen" });
    await api("POST", `/api/bots/${botId}/read`, { threadId, reason: "seen" });
    expect(await reloaded(), "being on screen reads it no more").toMatchObject({ unread: true, heldUnread: told.heldUnread });
    await api("POST", `/api/bots/${botId}/read`, { threadId, reason: "open" });
    expect(await reloaded(), "opening it again").toMatchObject({ unread: false });
    expect(await reloaded()).not.toHaveProperty("heldUnread");

    await mark();
    await api("POST", `/api/bots/${botId}/read`, { threadId });
    expect(await reloaded(), "an app that says no reason reads it as before").toMatchObject({ unread: false });
    expect(await reloaded()).not.toHaveProperty("heldUnread");

    await mark();
    await answered("And the backlog?");
    expect(await reloaded(), "writing in it, then its reply").not.toHaveProperty("heldUnread");
    await api("POST", `/api/bots/${botId}/read`, { threadId, reason: "seen" });
    expect(await reloaded(), "a newer reply on screen is read").toMatchObject({ unread: false });
  } finally {
    otherWindow.close();
    await fixture.close();
  }
}, 120_000);

it("ends the mark, in every window, when a routine reports into the conversation, so being on screen reads it again", async () => {
  const fixture = await launchVerificationServer();
  const { url } = fixture.info;
  const otherWindow = await openSse(`${url}/api/events`, { origin: url });
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  try {
    const { bot: created } = await runControlOmb(["new-bot", "--name", "Reports", "--url", url]) as any;
    const botId = created.id as string;
    const threadId = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === botId).threadId as string;
    const reloaded = async () => ((await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === botId)).tasks
      .find((task: any) => task.threadId === threadId) as { unread?: boolean; heldUnread?: string };
    const told = (held: boolean, after: number) => otherWindow.until((frame) => otherWindow.frames.indexOf(frame) >= after && frame.kind === "bot" && frame.bot?.id === botId &&
      frame.bot.tasks?.some((task: any) => task.threadId === threadId && task.unread === true && (task.heldUnread !== undefined) === held), 15_000);
    const { routine } = await api("POST", "/api/routines", {
      name: "Morning report", prompt: "Report this run's state.", botId, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);

    const beforeMark = otherWindow.frames.length;
    await api("PATCH", `/api/bots/${botId}`, { unread: true });
    await told(true, beforeMark);
    await api("POST", `/api/bots/${botId}/read`, { threadId, reason: "seen" });
    expect(await reloaded(), "held before the report").toMatchObject({ unread: true, heldUnread: expect.any(String) });

    const beforeReport = otherWindow.frames.length;
    const { run } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((one: any) => one.id === run.id)?.report?.state,
      { timeout: 30_000 }).toBe("posted");
    await told(false, beforeReport);
    expect(await reloaded(), "a reloaded page reads the same").toMatchObject({ unread: true });
    expect(await reloaded()).not.toHaveProperty("heldUnread");
    await api("POST", `/api/bots/${botId}/read`, { threadId, reason: "seen" });
    expect(await reloaded(), "the report on screen is read").toMatchObject({ unread: false });
  } finally {
    otherWindow.close();
    await fixture.close();
  }
}, 120_000);
