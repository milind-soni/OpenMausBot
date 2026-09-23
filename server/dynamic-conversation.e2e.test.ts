import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import type { WireMessage as Message, WireGroup } from "../shared/wire.ts";

const envelope = (next?: string) => `<openmaus-goal>${JSON.stringify(next ? { status: "continue", next, instruction: "Respond to the other member." } : { status: "completed", detail: "The discussion is complete." })}</openmaus-goal>`;

async function fixtureWithReplies(replies: string[], run: (context: {
  api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  room: WireGroup; statePath: string; promptsPath: string; finishGate: string;
}) => Promise<void>, holdReply = false) {
  const directory = mkdtempSync(join(tmpdir(), "omb-dynamic-script-"));
  const statePath = join(directory, "replies.txt");
  const promptsPath = join(directory, "prompts.jsonl");
  const finishGate = join(directory, "finish");
  const fixture = await launchVerificationServer({ ...process.env,
    FAKE_CLAUDE_PROMPTS: promptsPath, FAKE_CLAUDE_REPLIES: JSON.stringify(replies), FAKE_CLAUDE_REPLY_STATE: statePath,
    ...(holdReply ? { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate } : {}),
  });
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
    return value as T;
  };
  try {
    const members = [];
    for (const name of ["Ada", "Bo"]) {
      const result = await runControlOmb(["new-bot", "--url", fixture.info.url, "--name", name]) as { bot: { id: string } };
      members.push(result.bot.id);
    }
    const { group: room } = await api<{ group: WireGroup }>("POST", "/api/groups", {
      name: "Dynamic verification", memberIds: members,
      setup: { bulletin: "Keep the shared discussion focused.", defaultResponder: { kind: "dynamic" } },
    });
    await run({ api, room, statePath, promptsPath, finishGate });
  } finally {
    await fixture.close();
    await removeTempDir(directory);
  }
}

it("publishes in-flight dynamic progress through the shared step runtime", async () => {
  await fixtureWithReplies(["The answer is ready." + envelope(), envelope()], async ({ api, room, finishGate }) => {
    await api("POST", `/api/groups/${room.id}/messages`, { text: "Discuss the request." });
    const snapshot = async () => (await api<{ groups: (WireGroup & { messages: Message[] })[] }>("GET", "/api/bots?messages=50")).groups.find(group => group.id === room.id)!;
    await expect.poll(async () => (await snapshot()).messages.find(message => message.tool?.name.startsWith("Dynamic conversation"))?.tool?.name,
      { timeout: 20_000 }).toMatch(/^Dynamic conversation · Ada is working on team turn 1 of /);
    writeFileSync(finishGate, "continue");
    await expect.poll(async () => (await snapshot()).working, { timeout: 20_000 }).toBe(false);
    expect((await snapshot()).messages.find(message => message.tool?.name.startsWith("Dynamic conversation"))?.tool?.ok).toBe(true);
  }, true);
}, 60_000);

it("runs topic-driven turns through the real room runtime and hides the private ending check", async () => {
  await fixtureWithReplies([
    "Bo, what did you find?" + envelope("Bo"),
    "The dependency is confirmed, Ada." + envelope("Ada"),
    "That resolves the question." + envelope(),
    "This private scheduling text must not be displayed." + envelope(),
  ], async ({ api, room, statePath, promptsPath }) => {
    await api("POST", `/api/groups/${room.id}/messages`, { text: "Review the dependency together." });
    const snapshot = async () => (await api<{ groups: (WireGroup & { messages: Message[] })[] }>("GET", "/api/bots?messages=50")).groups.find(group => group.id === room.id)!;
    await expect.poll(async () => {
      const state = await snapshot();
      return { working: state.working, replies: state.messages.filter(message => message.kind === "text" && message.role === "bot").length };
    }, { timeout: 40_000 }).toEqual({ working: false, replies: 3 });
    const state = await snapshot();
    expect(state.defaultResponder).toEqual({ kind: "dynamic" });
    expect(state.messages.find(message => message.tool?.name.startsWith("Dynamic conversation"))?.tool).toMatchObject({ ok: true, name: "Dynamic conversation · The discussion is complete." });
    expect(state.messages.filter(message => message.kind === "text" && message.role === "bot").map(message => message.from?.name)).toEqual(["Ada", "Bo", "Ada"]);
    expect(JSON.stringify(state.messages)).not.toMatch(/openmaus-goal|private scheduling text/);
    expect(Number(readFileSync(statePath, "utf8"))).toBe(4);
    const lastRequest = JSON.parse(readFileSync(promptsPath, "utf8").trim().split("\n").at(-1)!);
    expect(lastRequest.message.content).toContain('"phase":"ending"');
    expect(lastRequest.message.content).toContain('"publicReplies":2');
    expect(lastRequest.message.content).toContain("The dependency is confirmed");
  });
}, 60_000);

it("persists the mode, emits wrap-up notices through reply 22, then starts a new allowance for a new user message", async () => {
  const replies = Array.from({ length: 22 }, (_, index) => `Contribution ${index + 1}.` + envelope(index % 2 ? "Ada" : "Bo"));
  await fixtureWithReplies([...replies, "New discussion answered." + envelope(), envelope()], async ({ api, room, statePath }) => {
    await api("POST", `/api/groups/${room.id}/messages`, { text: "Discuss the remaining points." });
    const snapshot = async () => (await api<{ groups: (WireGroup & { messages: Message[] })[] }>("GET", "/api/bots?messages=100")).groups.find(group => group.id === room.id)!;
    await expect.poll(async () => {
      const state = await snapshot();
      return { working: state.working, stopped: state.messages.some(message => message.systemNotice?.kind === "dynamic-stop") };
    }, { timeout: 90_000 }).toEqual({ working: false, stopped: true });
    const state = await snapshot();
    expect(state.messages.filter(message => message.systemNotice).map(message => message.systemNotice?.repliesSinceUser)).toEqual([16, 17, 18, 19, 20, 21, 22]);
    expect(state.messages.filter(message => message.kind === "text" && message.role === "bot" && !message.systemNotice)).toHaveLength(22);
    expect(Number(readFileSync(statePath, "utf8"))).toBe(22);
    await api("POST", `/api/groups/${room.id}/messages`, { text: "Now answer a new question." });
    await expect.poll(async () => (await snapshot()).messages.some(message => message.text === "New discussion answered."), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await snapshot()).working, { timeout: 20_000 }).toBe(false);
    expect(Number(readFileSync(statePath, "utf8"))).toBe(24);
    // Evidence stays with the fixture log, never in the contribution.
    writeFileSync(`${statePath}.evidence.json`, JSON.stringify({ notices: 7, firstDiscussionCalls: 22, totalCalls: 24 }));
  });
}, 120_000);
