import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import type { SuggestionRow } from "../../shared/suggested-reply.ts";
import type { ModelCatalog, TextGenerationOptions } from "../contracts.ts";
import { createJobSlots } from "../job-slots.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createSideJobs, type SideJobBot, type SideJobInstance, type SideJobsDeps } from "../side-jobs.ts";
import { lightModelFor } from "../suggested-reply/light-model.ts";
import { createSuggestedReplyRoutes, type SuggestedReplyDeps } from "./suggested-reply.ts";
import { PASS, type RouteContext } from "./table.ts";

const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
const REPLY = "I drafted the launch email and saved it in your drafts folder for review.";
const rows: SuggestionRow[] = [
  { id: "u0", role: "user", kind: "text", text: "SECRET-OLDER-QUESTION" },
  { id: "b0", role: "bot", kind: "text", text: "SECRET-OLDER-ANSWER that is long enough to count" },
  { id: "u1", role: "user", kind: "text", text: "Draft the launch email" },
  { id: "s1", role: "bot", kind: "activity" },
  { id: "b1", role: "bot", kind: "text", text: REPLY },
];

function request(body: unknown, path = "/api/suggested-reply", method = "POST") {
  const sent: { status?: number; body?: unknown } = {};
  const res = Object.assign(new EventEmitter(), { writableFinished: false, writableEnded: false, destroyed: false });
  const context = { req: {} as RouteContext["req"], res: res as unknown as RouteContext["res"], url: new URL(`http://x${path}`), path, method, auth,
    json: ((_res: unknown, status: number, value: unknown) => { sent.status = status; sent.body = value; res.writableEnded = true; res.writableFinished = true; }) as unknown as RouteContext["json"],
    readBody: (async () => body) as unknown as RouteContext["readBody"] } as RouteContext;
  return { context, sent, res };
}

type Call = { prompt: string; options?: TextGenerationOptions; via: "text" | "background" };

function engine(instanceId: string, driverKind: string, models: ModelCatalog, answer = "Send it to Priya too") {
  const calls: Call[] = [];
  const instance: SideJobInstance = {
    instanceId, driverKind, enabled: true, models, adapter: { capabilities: { agentsMcp: true } },
    generateText: async (prompt, options) => { calls.push({ prompt, options, via: "text" }); return answer; },
    generateMemoryText: async (prompt, options) => { calls.push({ prompt, options, via: "background" }); return answer; },
  };
  return { instance, calls };
}

function sideJobs(instances: SideJobInstance[], over: Partial<SideJobsDeps> = {}) {
  const booked: Array<Parameters<SideJobsDeps["book"]>[0]> = [];
  const bots = new Map<string, SideJobBot>(instances.map((one) => [one.instanceId, { id: one.instanceId, name: one.instanceId, threadId: "t", modelSelection: { instanceId: one.instanceId, model: one.models.default } }]));
  const jobs = createSideJobs({
    bot: (id) => bots.get(id), instance: (id) => instances.find((one) => one.instanceId === id), refusal: () => undefined,
    helper: () => ({ instanceId: "helper" }), smallModels: { refused: () => new Set(), remember: () => {} },
    assertWithinBudget: () => {}, book: (row) => { booked.push(row); }, slots: createJobSlots(2), lightModel: lightModelFor, ...over,
  });
  return { jobs, booked };
}

function deps(jobs: ReturnType<typeof sideJobs>["jobs"], over: Partial<SuggestedReplyDeps> = {}): SuggestedReplyDeps {
  return { enabled: () => true, owns: () => true, sees: () => true, mayChat: () => true, messages: () => rows, busy: () => false, writer: (botId) => jobs.text("suggested-reply", botId), ...over };
}

describe("POST /api/suggested-reply", () => {
  it("asks the bot's own engine on its smallest model, with only the last exchange", async () => {
    const claude = engine("claude", "claudeAgent", { default: "claude-opus-5-5", options: [{ id: "claude-opus-5-5", label: "Opus" }, { id: "claude-haiku-5-5", label: "Haiku" }] });
    const { jobs } = sideJobs([claude.instance]);
    const { context, sent } = request({ botId: "claude", threadId: "t", after: "b1" });
    await createSuggestedReplyRoutes(deps(jobs))(context);
    expect(sent).toEqual({ status: 200, body: { text: "Send it to Priya too" } });
    expect(claude.calls).toHaveLength(1);
    const [call] = claude.calls;
    expect(call!.via).toBe("text");
    expect(call!.options?.model).toBe("claude-haiku-5-5");
    expect(call!.prompt).toContain("Draft the launch email");
    expect(call!.prompt).toContain(REPLY);
    expect(call!.prompt).not.toContain("SECRET-OLDER");
  });

  it("runs Codex's background call pinned to its small model, never the bot's own", async () => {
    const codex = engine("codex", "codex", { default: "gpt-6", options: [{ id: "gpt-6", label: "GPT-6" }, { id: "gpt-6-luna", label: "Luna" }] });
    const { jobs } = sideJobs([codex.instance]);
    const { context, sent } = request({ botId: "codex", threadId: "t", after: "b1" });
    await createSuggestedReplyRoutes(deps(jobs))(context);
    expect(sent.body).toEqual({ text: "Send it to Priya too" });
    expect(codex.calls[0]).toMatchObject({ via: "background", options: { model: "gpt-6-luna", fallback: { model: "gpt-6-luna" } } });
  });

  it("is off, with no call and no helper, for an engine without a small model", async () => {
    const big = engine("claude", "claudeAgent", { default: "claude-opus-5-5", options: [{ id: "claude-opus-5-5", label: "Opus" }] });
    const helper = engine("helper", "claudeAgent", { default: "claude-haiku-5-5", options: [{ id: "claude-haiku-5-5", label: "Haiku" }] });
    const { jobs } = sideJobs([big.instance, helper.instance]);
    const { context, sent } = request({ botId: "claude", threadId: "t", after: "b1" });
    await createSuggestedReplyRoutes(deps(jobs))(context);
    expect(sent.body).toEqual({ text: null });
    expect(big.calls).toHaveLength(0);
    expect(helper.calls).toHaveLength(0);
  });

  it("asks nothing when switched off, while the bot works, or for a reply that is no longer the last", async () => {
    const claude = engine("claude", "claudeAgent", { default: "claude-haiku-5-5", options: [{ id: "claude-haiku-5-5", label: "Haiku" }] });
    const { jobs } = sideJobs([claude.instance]);
    for (const [over, after] of [[{ enabled: () => false }, "b1"], [{ busy: () => true }, "b1"], [{}, "b0"]] as const) {
      const { context, sent } = request({ botId: "claude", threadId: "t", after });
      await createSuggestedReplyRoutes(deps(jobs, over))(context);
      expect(sent.body).toEqual({ text: null });
    }
    expect(claude.calls).toHaveLength(0);
  });

  it("answers 404 to someone who can't read or write in the conversation", async () => {
    const { jobs } = sideJobs([]);
    for (const over of [{ sees: () => false }, { owns: () => false }, { mayChat: () => false }]) {
      const { context, sent } = request({ botId: "claude", threadId: "t", after: "b1" });
      await createSuggestedReplyRoutes(deps(jobs, over))(context);
      expect(sent.status).toBe(404);
    }
  });

  it("drops a suggestion when a new turn started while it was written, and fails silently", async () => {
    let messages = rows;
    const claude = engine("claude", "claudeAgent", { default: "claude-haiku-5-5", options: [{ id: "claude-haiku-5-5", label: "Haiku" }] });
    claude.instance.generateText = async () => { messages = [...rows, { id: "u2", role: "user", kind: "text", text: "one more thing" }]; return "Send it"; };
    const { jobs } = sideJobs([claude.instance]);
    const first = request({ botId: "claude", threadId: "t", after: "b1" });
    await createSuggestedReplyRoutes(deps(jobs, { messages: () => messages }))(first.context);
    expect(first.sent.body).toEqual({ text: null });

    claude.instance.generateText = async () => { throw new Error("rate limited"); };
    messages = rows;
    const second = request({ botId: "claude", threadId: "t", after: "b1" });
    await createSuggestedReplyRoutes(deps(jobs, { messages: () => messages }))(second.context);
    expect(second.sent.body).toEqual({ text: null });
  });

  it("cancels the call when the composer goes away, and keeps one in flight per thread", async () => {
    const signals: AbortSignal[] = [];
    const claude = engine("claude", "claudeAgent", { default: "claude-haiku-5-5", options: [{ id: "claude-haiku-5-5", label: "Haiku" }] });
    claude.instance.generateText = (_prompt, options) => new Promise((_resolve, reject) => {
      signals.push(options!.signal!);
      options!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const { jobs } = sideJobs([claude.instance]);
    const routes = createSuggestedReplyRoutes(deps(jobs));
    const first = request({ botId: "claude", threadId: "t", after: "b1" });
    const firstDone = routes(first.context);
    await waitUntil(() => signals.length === 1);
    const second = request({ botId: "claude", threadId: "t", after: "b1" });
    const secondDone = routes(second.context);
    await waitUntil(() => signals.length === 2);
    expect(signals[0]!.aborted).toBe(true);
    await firstDone;
    expect(first.sent.body).toEqual({ text: null });
    second.res.destroyed = true;
    second.res.emit("close");
    await secondDone;
    expect(signals[1]!.aborted).toBe(true);
    expect(second.sent.status).toBeUndefined();
  });

  it("passes other paths", async () => {
    const { jobs } = sideJobs([]);
    expect(await createSuggestedReplyRoutes(deps(jobs))(request({}, "/api/bots", "GET").context)).toBe(PASS);
  });
});

async function waitUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done()).toBe(true);
}
