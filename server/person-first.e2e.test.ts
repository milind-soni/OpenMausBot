// A person writes to a bot that is stuck in a long tool call (a CI poll): the fake Claude CLI's scripted Bash call holds
// until it is stopped, so the steered message is never read. With the wait set to 1.5 s, the server stops that turn and
// the bot answers in a new turn that leads with the person's words and says what was stopped.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const POLL = { name: "Bash", input: { command: "gh run view 42; sleep 30" }, hold: true };
const QUESTION = "Is the PR up yet?";
const ANSWER = "Yes: PR #42 is up. CI is still running, and I will tell you when it is done.";

it("stops a turn that keeps the person's message unread in a long tool call, and answers it next", async () => {
  const folder = mkdtempSync(join(tmpdir(), "omb-person-first-"));
  const calls = join(folder, "calls.json"), markers = join(folder, "markers.json");
  writeFileSync(markers, JSON.stringify({ [QUESTION]: ANSWER }));
  const owner = randomBytes(32).toString("base64url");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => realFetch(input, { ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), "x-openmausbot-desktop-owner": owner } });
  const fixture = await launchVerificationServer({ ...process.env, OMB_TEST_DESKTOP_OWNER_TOKEN: owner, OMB_PERSON_FIRST_MS: "1500",
    FAKE_CLAUDE_TOOL_CALLS_FILE: calls, FAKE_CLAUDE_MARKER_REPLIES: markers });
  try {
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as any };
    };
    const bot = ((await runControlOmb(["new-bot", "--name", "Scout", "--url", fixture.info.url])) as { bot: { id: string; activeTaskId: string } }).bot;
    const threadId = bot.activeTaskId;
    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages;
    const busy = async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((entry: { id: string }) => entry.id === bot.id)?.busy === true;
    writeFileSync(calls, JSON.stringify([POLL]));

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Open the PR and watch CI", threadId })).status).toBe(202);
    await expect.poll(async () => (await transcript()).some((message) => message.kind === "activity" && JSON.stringify(message.tool ?? {}).includes("gh run view 42")),
      { timeout: hostTimeout(20_000) }).toBe(true);
    rmSync(calls, { force: true });

    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: QUESTION, threadId });
    expect(sent.status).toBe(202);
    expect(sent.body.steered).toBe(true);

    await expect.poll(async () => (await transcript()).some((message) => message.role === "bot" && message.kind === "text" && message.text === ANSWER),
      { timeout: hostTimeout(30_000) }).toBe(true);
    await expect.poll(busy, { timeout: hostTimeout(15_000) }).toBe(false);
    const rows = await transcript();
    const asked = rows.filter((message) => message.role === "user" && message.text === QUESTION);
    expect(asked, "the person's message stays one row").toHaveLength(1);
    const stopped = rows.findIndex((message) => message.kind === "activity" && /^Stopped a step that had run for \d+ s, to answer you first$/.test(message.tool?.name ?? ""));
    const answered = rows.findIndex((message) => message.role === "bot" && message.text === ANSWER);
    expect(rows.indexOf(asked[0])).toBeLessThan(stopped);
    expect(stopped).toBeLessThan(answered);
    const content = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).prompt?.message?.content;
    const prompt = typeof content === "string" ? content : (content as Array<{ text?: string }>).map((block) => block.text ?? "").join("\n");
    expect(prompt).toContain(QUESTION);
    expect(prompt).toContain('[OpenMausBot: your step "Bash: gh run view 42; sleep 30" had run for');
  } finally {
    globalThis.fetch = realFetch;
    await fixture.close();
    await removeTempDir(folder);
  }
}, hostTimeout(90_000));
