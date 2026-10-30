// Real server, the repository's fake Claude held silent: the first-reply rescue end to end.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

it("posts one rescue notice into a silent first reply, readable as plain text, and settles it when the reply starts", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-first-reply-"));
  const release = join(scratch, "release");
  const fixture = await launchVerificationServer({
    ...process.env, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: release, OMB_FIRST_REPLY_NOTICE_MS: "1500",
  });
  const { url } = fixture.info;
  const control = (args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string) => {
    const response = await fetch(`${url}${path}`, { method, headers: { origin: url } });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const stream = await openSse(`${url}/api/events`, { origin: url });
  try {
    const { bot } = await control(["new-bot", "--name", "Maus"]);
    const threadId = bot.activeTaskId;
    const instanceId = bot.modelSelection.instanceId;
    const ai = ((await api("GET", "/api/instances")).instances as any[]).find((instance) => instance.instanceId === instanceId).displayName;
    expect(ai).toBeTruthy();
    expect(ai).not.toBe(instanceId);
    expect((await control(["send", "--bot", bot.id, "--task", threadId, "--text", "Hello?"])).success).toBe(true);

    const notice = await vi.waitFor(async () => {
      const row = (await messages(threadId)).find((message) => message.tool?.rescue);
      if (!row) throw new Error("waiting for the rescue notice");
      return row;
    }, { timeout: 20_000, interval: 200 });
    expect(notice).toMatchObject({ role: "bot", kind: "activity", turnId: expect.any(String) });
    const asked = (await messages(threadId)).find((message) => message.role === "user" && message.text === "Hello?");
    expect(notice.tool).toEqual({
      name: `notice: Maus hasn't heard back from ${ai} yet.`,
      ok: true,
      rescue: { botId: bot.id, threadId, turnId: notice.turnId, requestMessageId: asked.id, instanceId, ai },
    });
    // A client that only prints tool names (the phones) gets the whole sentence in the live frame.
    expect(stream.frames.some((frame) => frame.kind === "message" && frame.message?.tool?.name === notice.tool.name)).toBe(true);

    writeFileSync(release, "go");
    expect((await control(["wait", "--bot", bot.id, "--task", threadId, "--timeout", "30"])).status).toBe("settled");
    const after = await messages(threadId);
    expect(after.filter((message) => message.tool?.rescue)).toHaveLength(1);
    expect(after.find((message) => message.id === notice.id).tool).toEqual({
      name: `notice: ${ai} answered after a slow start.`,
      ok: true,
      rescue: { botId: bot.id, threadId, turnId: notice.turnId, requestMessageId: asked.id, instanceId, ai, settled: true },
    });
    expect(after.some((message) => message.kind === "text" && message.text === "released")).toBe(true);
  } finally {
    stream.close();
    await fixture.close();
    removeTempDir(scratch);
  }
}, 120_000);
