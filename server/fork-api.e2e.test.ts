import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

it("forks bot and room conversations through the public API and keeps a fork after source deletion", async () => {
  const fixture = await launchVerificationServer();
  const dump = join(fixture.info.dataDir, "fake-claude-dump.json");
  const { url } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as Array<{ id: string; role: string; kind: string; text?: string }>;

  try {
    const bot = (await runControlOmb(["new-bot", "--name", "Fork Tester", "--url", url]) as any).bot;
    const sourceThreadId = bot.activeTaskId as string;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Plan the release", threadId: sourceThreadId })).status).toBe(202);
    await expect.poll(async () => (await messages(sourceThreadId)).some((message) => message.role === "bot" && message.kind === "text" && message.text?.includes("hello from fake claude")), { timeout: 20_000 }).toBe(true);
    const anchor = (await messages(sourceThreadId)).find((message) => message.role === "user" && message.text === "Plan the release")!;
    const forked = await api("POST", `/api/bots/${bot.id}/tasks/${sourceThreadId}/forks`, { messageId: anchor.id });
    expect(forked.status).toBe(201);
    const forkThreadId = forked.body.task.threadId as string;
    expect(forked.body.task.origin).toEqual({ threadId: sourceThreadId, messageId: anchor.id });
    expect(forked.body.task.unread).toBe(false);
    const sourceMessages = await messages(sourceThreadId);
    expect((await messages(forkThreadId)).map((message) => message.id)).toEqual(sourceMessages.slice(0, sourceMessages.findIndex((message) => message.id === anchor.id) + 1).map((message) => message.id));
    expect((await api("GET", `/api/search?q=Plan%20the%20release&threadId=${forkThreadId}`)).body.hits.some((hit: { messageId: string }) => hit.messageId === anchor.id)).toBe(true);
    expect((await api("POST", `/api/bots/${bot.id}/tasks/${sourceThreadId}/forks`, { messageId: "missing" })).status).toBe(404);
    const uploaded = await fetch(url + "/api/attachments", { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
    expect(uploaded.status).toBe(201);
    const imagePath = (await uploaded.json() as { path: string }).path;
    const repliesBeforeImage = (await messages(sourceThreadId)).filter((message) => message.role === "bot" && message.kind === "text").length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: `Image\n<attached-image path="${imagePath}" name="dot.png" />`, threadId: sourceThreadId })).status).toBe(202);
    await expect.poll(async () => (await messages(sourceThreadId)).filter((message) => message.role === "bot" && message.kind === "text").length, { timeout: 20_000 }).toBeGreaterThan(repliesBeforeImage);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === bot.id)?.busy, { timeout: 20_000 }).toBe(false);
    const imageMessage = (await messages(sourceThreadId)).find((message) => message.role === "user" && message.text?.includes("dot.png"))!;
    const imageFork = await api("POST", `/api/bots/${bot.id}/tasks/${sourceThreadId}/forks`, { messageId: imageMessage.id });
    expect(imageFork.status).toBe(201);
    expect((await api("DELETE", `/api/bots/${bot.id}/tasks/${sourceThreadId}`)).status).toBe(200);
    expect((await messages(forkThreadId)).some((message) => message.id === anchor.id)).toBe(true);
    const inheritedImage = await fetch(url + `/api/threads/${imageFork.body.task.threadId}/messages/${imageMessage.id}/file`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: imagePath }),
    });
    const imageBytes = Buffer.from(await inheritedImage.arrayBuffer());
    expect(inheritedImage.status, imageBytes.toString()).toBe(200);
    expect(imageBytes).toEqual(PNG);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Continue the fork", threadId: forkThreadId })).status).toBe(202);
    await expect.poll(async () => (await messages(forkThreadId)).some((message) => message.role === "bot" && message.text?.includes("hello from fake claude")), { timeout: 20_000 }).toBe(true);
    const prompt = JSON.stringify(JSON.parse(readFileSync(dump, "utf8")).prompt);
    expect(prompt).toContain("Plan the release");
    expect(prompt).toContain("Continue the fork");

    const room = (await runControlOmb(["new-channel", "--name", "Fork Room", "--members", bot.id, "--url", url]) as any).channel;
    const roomThreadId = room.activeTaskId as string;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Room question", threadId: roomThreadId })).status).toBe(202);
    await expect.poll(async () => (await messages(roomThreadId)).some((message) => message.role === "bot" && message.kind === "text"), { timeout: 20_000 }).toBe(true);
    const roomAnchor = (await messages(roomThreadId)).find((message) => message.role === "user" && message.text === "Room question")!;
    const roomFork = await api("POST", `/api/groups/${room.id}/tasks/${roomThreadId}/forks`, { messageId: roomAnchor.id });
    expect(roomFork.status).toBe(201);
    expect(roomFork.body.task.origin).toEqual({ threadId: roomThreadId, messageId: roomAnchor.id });
    expect((await api("POST", `/api/groups/${room.id}/read`, { threadId: roomFork.body.task.threadId })).status).toBe(200);
    expect((await api("DELETE", `/api/groups/${room.id}/tasks/${roomThreadId}`)).status).toBe(200);
    expect((await messages(roomFork.body.task.threadId)).some((message) => message.id === roomAnchor.id)).toBe(true);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Continue the room fork", threadId: roomFork.body.task.threadId })).status).toBe(202);
    await expect.poll(async () => (await messages(roomFork.body.task.threadId)).some((message) => message.role === "bot" && message.kind === "text"), { timeout: 20_000 }).toBe(true);
    const roomPrompt = JSON.stringify(JSON.parse(readFileSync(dump, "utf8")).prompt);
    expect(roomPrompt).toContain("Room question");
    expect(roomPrompt).toContain("Continue the room fork");
  } finally {
    await fixture.close();
  }
}, 90_000);
