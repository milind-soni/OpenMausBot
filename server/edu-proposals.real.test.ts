// Runs only where Edu 6+ is installed (CI has none). Every brain is in a temporary folder.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { OptionCardData } from "../shared/wire.ts";
import { createEduBrains, locateEduCli, type EduStdioServer } from "./edu-brain.ts";
import { createEduProposals } from "./edu-proposals.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const cli = locateEduCli({ PATH: process.env.PATH }, process.env.PATH ?? "");
const root = mkdtempSync(join(tmpdir(), "edu-proposals-real-"));
afterAll(() => removeTempDir(root));

/** Calls tools on a real `edu mcp` once, then closes it. */
async function propose(server: EduStdioServer, env: NodeJS.ProcessEnv, calls: Array<{ name: string; arguments: object }>): Promise<string[]> {
  const child = spawn(server.command, server.args, { env: { ...env, ...server.env, EDU_CREW_JOB: "" }, stdio: ["pipe", "pipe", "ignore"] });
  const replies = new Map<number, (text: string) => void>();
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        const message = JSON.parse(line) as { id?: number; result?: { content?: Array<{ text?: string }> }; error?: { message: string } };
        if (message.id !== undefined) replies.get(message.id)?.(message.result?.content?.[0]?.text ?? message.error?.message ?? "");
      } catch {}
    }
  });
  const request = (id: number, method: string, params: object) => new Promise<string>((done) => {
    replies.set(id, done);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await request(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "edu-bot-test", version: "0" } });
    const texts: string[] = [];
    for (const [index, call] of calls.entries()) texts.push(await request(index + 1, "tools/call", call));
    return texts;
  } finally {
    child.kill();
  }
}

describe.skipIf(!cli)("Edu proposals with the installed Edu binary", () => {
  const dataDir = join(root, "data"), eduHome = join(root, "global"), home = join(root, "home");
  const env = { ...process.env, HOME: home, USERPROFILE: home, OMB_EDU_CLI: cli!, EDU_CREW_JOB: "" };
  const brains = createEduBrains({ dataDir, config: () => ({ home: eduHome }), env });
  const bot = { id: "bot-real", name: "Luna", color: "blue", threadId: "t-main" };
  const messages: Array<{ id: string; card?: OptionCardData }> = [];
  const proposals = createEduProposals({
    brains,
    store: {
      bots: [bot], groups: [], bot: (id) => (id === bot.id ? bot : null), tasks: () => [],
      messagesFor: () => messages,
      appendMessage: (_threadId, message) => { messages.push({ id: `m${messages.length}`, card: message.card }); return { id: `m${messages.length - 1}` }; },
      patchMessage: (_threadId, id, patch) => { const at = messages.findIndex((message) => message.id === id); messages[at] = { ...messages[at]!, ...patch }; },
    },
    inRoom: () => false, decide: () => {}, desktop: true, env,
  });
  const brain = join(dataDir, "brains", bot.id);
  const pending = () => JSON.parse(execFileSync(process.execPath, [cli!, "--cwd", brain, "brain", "proposals", "--json"], { env: { ...env, EDU_HOME: eduHome }, encoding: "utf8" })) as Array<{ id: string }>;

  it("cards what the bot proposed, approves one and rejects the other through Edu itself", async () => {
    mkdirSync(home, { recursive: true });
    execFileSync(process.execPath, [cli!, "init", "--global", "--name", "Global"], { env: { ...env, EDU_HOME: eduHome } });
    const server = await brains.integration(bot, { local: true });
    expect(server).not.toBeNull();
    const said = await propose(server!, env, [
      { name: "edu_propose_canonical", arguments: { kind: "standard", title: "Real ISO dates", body: "Dates as YYYY-MM-DD." } },
      { name: "edu_propose_canonical", arguments: { kind: "preference", title: "Real short answers", body: "Answers stay short." } },
    ]);
    expect(said.every((text) => text.startsWith("Proposed")), said.join("\n")).toBe(true);

    await proposals.sweep("t-main", bot.id, brain);
    expect(messages.map((message) => [message.card?.eduProposal?.id, message.card?.eduProposal?.global])).toEqual([["K-real-iso-dates", false], ["K-real-short-answers", false]]);
    expect(messages[0]!.card!.eduProposal!.body).toBe("Dates as YYYY-MM-DD.");

    expect(await proposals.resolve("t-main", messages[0]!.card!.requestId!, "allow")).toEqual({ ok: true, outcome: "allowed-once" });
    expect(readFileSync(join(brain, ".edu", "brain", "1-canonical", "standard", "real-iso-dates.md"), "utf8")).toMatch(/^status: accepted$/m);
    expect(await proposals.resolve("t-main", messages[1]!.card!.requestId!, "deny")).toEqual({ ok: true, outcome: "rejected" });
    expect(pending()).toEqual([]);
    expect(messages.map((message) => message.card!.answered)).toEqual(["allow", "deny"]);
  }, 60_000);

  it("refuses to decide while Edu Bot carries a crew-worker guard, as Edu does", async () => {
    const guarded = createEduProposals({
      brains, store: { bots: [bot], groups: [], bot: () => bot, tasks: () => [], messagesFor: () => [], appendMessage: () => ({ id: "x" }), patchMessage: () => {} },
      inRoom: () => false, decide: () => {}, desktop: true, env: { ...env, EDU_CREW_JOB: "outer-job" },
    });
    const said = await propose((await brains.integration(bot, { local: true }))!, env, [
      { name: "edu_propose_canonical", arguments: { kind: "standard", title: "Real guarded", body: "Stays proposed." } },
    ]);
    expect(said[0]).toMatch(/^Proposed/);
    expect(await guarded.decideFor(bot, "K-real-guarded", true)).toMatchObject({ ok: false, status: 409 });
    expect(pending().map((proposal) => proposal.id)).toEqual(["K-real-guarded"]);
  }, 60_000);
});
