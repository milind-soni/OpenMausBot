// Box agent contract tests against a scripted fake of boat.dev's box HTTP
// API. The driver polls events + prompt status; the fake advances one poll
// per GET so we can assert message → tool → message order without sleeping.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { BoxAgentDriver } from "./boxagent.ts";
import { OMB_ASK_TOOL } from "../../shared/ask-question.ts";

const BOX = "box-1";
const PROMPT = "p1";

/** A fenced omb-ask block exactly as the prompt contract tells the box to
 * write one. */
const askBlock = (questions: unknown[]) => "```omb-ask\n" + JSON.stringify({ questions }) + "\n```";

/** JSON Response helper for the in-process Box HTTP fake. */
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Poll = { events: unknown[]; status?: { promptRun: { status: string; result?: string } } };

/** Stub fetch so each GET /events + /prompts pair advances one poll in `script`.
 * Posted prompt bodies land in `prompts` so tests can assert what the box
 * was told — the ask contract and the answer continuation. */
function installFakeBox(script: Poll[], prompts: string[] = []) {
  let i = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/me")) return json({ ok: true });
    if (method === "POST" && /\/boxes\/[^/]+\/prompt$/.test(url)) {
      prompts.push(String((JSON.parse(String(init?.body ?? "{}")) as { prompt?: string }).prompt ?? ""));
      return json({ promptRun: { id: PROMPT } });
    }
    if (method === "POST" && url.includes("/interrupt")) return json({ ok: true });
    if (url.includes("/events")) {
      const step = script[Math.min(i, script.length - 1)]!;
      i += 1;
      return json({ events: step.events });
    }
    if (url.includes(`/prompts/${PROMPT}`)) {
      const step = script[Math.min(Math.max(i - 1, 0), script.length - 1)]!;
      return json(step.status ?? { promptRun: { status: "running" } });
    }
    return json({ error: `unexpected ${method} ${url}` }, 404);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

const computer = { boxId: BOX, token: "box-test-token" };

describe("BoxAgentDriver turns (fake API)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let restoreFetch: (() => void) | undefined;

  const create = async (configExtra: { askTimeoutMs?: number } = {}) => {
    instance = await BoxAgentDriver.create({
      instanceId: "box-test",
      displayName: "Box Test",
      environment: { BOX_TOKEN: "box-test-token" },
      enabled: true,
      config: { pollMs: 0, ...configExtra },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    restoreFetch?.();
    restoreFetch = undefined;
  });

  it("flushes prefix-grown text before a tool, then the tail at settle", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "hel" }],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "hel" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "hel" },
          { id: "e2", type: "tool", title: "run" },
          { id: "e3", type: "response", text: "hello there" },
        ],
        status: { promptRun: { status: "finished", result: "hello there" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-prefix", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed");

    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["hel", "lo there"]);
  });

  it("keeps a non-prefix response after a flush instead of slicing it away", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "before" }],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
          { id: "e3", type: "response", text: "after" },
        ],
        status: { promptRun: { status: "finished", result: "after" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-nonprefix", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // before
      "item.started",
      "content.delta",
      "item.completed", // after — must not be sliced to ""
      "turn.completed",
    ]);
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["before", "after"]);
  });

  it("ingests a non-prefix prompt result when events already set lastText", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "before" }],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "finished", result: "done" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-status", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed");

    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["before", "done"]);
  });

  it("flushes pending assistant text when the turn is interrupted", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "half" }],
        status: { promptRun: { status: "running" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cancel", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "content.delta");
    await instance.adapter.interruptTurn("t-cancel");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "interrupted" });
    const assistantIndex = recorder.events.findIndex(
      (event) => event.type === "item.completed" && (event as { itemType: string }).itemType === "assistant_text",
    );
    expect(assistantIndex).toBeLessThan(recorder.events.indexOf(done));
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["half"]);
  });

  it("holds the turn open on an omb-ask block, then continues it with the answer", async () => {
    const prompts: string[] = [];
    const askText = "Working.\n\n" + askBlock([
      { question: "Ship the release?", header: "Release", options: [{ label: "Ship now" }, { label: "Wait" }] },
    ]);
    restoreFetch = installFakeBox([
      { events: [{ id: "e1", type: "response", text: askText }], status: { promptRun: { status: "running" } } },
      { events: [{ id: "e1", type: "response", text: askText }], status: { promptRun: { status: "finished", result: askText } } },
      { events: [{ id: "c1", type: "response", text: "Shipped." }], status: { promptRun: { status: "finished", result: "Shipped." } } },
    ], prompts);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-ask", text: "go", integrations: { computer } });
    const opened = (await recorder.until((e) => e.type === "request.opened")) as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened).toMatchObject({
      requestType: "question",
      tool: OMB_ASK_TOOL,
      summary: "Ship the release?",
      choices: ["Ship now", "Wait"],
      origin: "output",
    });
    expect(opened.questions).toEqual([
      { question: "Ship the release?", header: "Release", options: [{ label: "Ship now" }, { label: "Wait" }] },
    ]);
    // the turn IS the ask: still open, nothing completed, prose already stripped
    expect(instance.adapter.hasSession("t-ask")).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    const texts = () => recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts()).toEqual(["Working."]);
    // an answer for another card cannot settle this one
    expect(await instance.adapter.respondToRequest("t-ask", "wrong-id", { behavior: "answer", message: "no" })).toBe("unavailable");
    expect(
      await instance.adapter.respondToRequest("t-ask", opened.requestId!, {
        behavior: "answer",
        message: "The user answered your questions.\n\nQ: Ship the release?\nA: ship it now",
      }),
    ).toBe("answered");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: null });
    const resolved = recorder.events.find((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "answer", source: "user" });
    expect(recorder.events.indexOf(resolved!)).toBeLessThan(recorder.events.indexOf(done));
    expect(prompts[0]).toContain("omb-ask");
    expect(prompts[1]).toContain("Q: Ship the release?");
    expect(prompts[1]).toContain("A: ship it now");
    expect(texts()).toEqual(["Working.", "Shipped."]);
  });

  it("does not open a held ask when the turn is interrupted before settle", async () => {
    const askText = "Working.\n\n" + askBlock([{ question: "Proceed?" }]);
    restoreFetch = installFakeBox([
      { events: [{ id: "e1", type: "response", text: askText }], status: { promptRun: { status: "running" } } },
    ]);
    await create({ askTimeoutMs: 60_000 });
    await instance.adapter.sendTurn({ threadId: "t-ask-cancel", text: "go", integrations: { computer } });
    // The ask block has streamed but the run has not settled: an interrupt
    // here must end the turn promptly, not register an ask whose timeout
    // keeps stop pending.
    await recorder.until((e) => e.type === "content.delta");
    await instance.adapter.interruptTurn("t-ask-cancel");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
  });

  it("interrupts a continuation whose POST was in flight when Stop landed", async () => {
    const askText = "Working.\n\n" + askBlock([{ question: "Proceed?" }]);
    const calls: string[] = [];
    let markStarted: () => void = () => {};
    const continuationStarted = new Promise<void>((resolve) => (markStarted = resolve));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let poll = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/me")) return json({ ok: true });
      if (method === "POST" && url.includes("/interrupt")) {
        calls.push("interrupt");
        return json({ ok: true });
      }
      if (method === "POST" && /\/boxes\/[^/]+\/prompt$/.test(url)) {
        const nth = calls.push("prompt");
        if (nth === 2) {
          // the continuation POST hangs until the test releases it, holding
          // the exact window where Stop lands on an idle box
          markStarted();
          await gate;
          calls.push("gate-open");
        }
        return json({ promptRun: { id: PROMPT } });
      }
      if (url.includes("/events")) {
        poll += 1;
        return json({ events: [{ id: "e1", type: "response", text: askText }] });
      }
      if (url.includes(`/prompts/${PROMPT}`)) {
        return json(poll >= 2 ? { promptRun: { status: "finished", result: askText } } : { promptRun: { status: "running" } });
      }
      return json({ error: `unexpected ${method} ${url}` }, 404);
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = previous;
    };
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cont-cancel", text: "go", integrations: { computer } });
    const opened = (await recorder.until((e) => e.type === "request.opened")) as Extract<RuntimeEvent, { type: "request.opened" }>;
    await instance.adapter.respondToRequest("t-cont-cancel", opened.requestId!, {
      behavior: "answer",
      message: "Q: Proceed?\nA: yes",
    });
    await continuationStarted;
    await instance.adapter.interruptTurn("t-cont-cancel");
    release();
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "interrupted" });
    // the guard interrupted the run that started after Stop, not just the
    // pre-continuation box
    // the guard interrupted the run that started after Stop: the final call
    // is an interrupt that landed after the continuation POST resolved
    expect(calls[calls.length - 1]).toBe("interrupt");
    expect(calls.lastIndexOf("interrupt")).toBeGreaterThan(calls.lastIndexOf("gate-open"));
  });

  it("does not reopen a question after the remote run was cancelled", async () => {
    const askText = askBlock([{ question: "Proceed?" }]);
    const prompts: string[] = [];
    restoreFetch = installFakeBox([
      { events: [{ id: "e1", type: "response", text: askText }], status: { promptRun: { status: "cancelled" } } },
    ], prompts);
    await create({ askTimeoutMs: 50 });
    await instance.adapter.sendTurn({ threadId: "t-remote-cancel", text: "go", integrations: { computer } });
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "cancelled" });
    expect(recorder.events.some(event => event.type === "request.opened")).toBe(false);
    expect(prompts).toHaveLength(1);
  });

  it("resolves a held ask on its timeout and completes the turn", async () => {
    const askText = askBlock([{ question: "Proceed?" }]);
    restoreFetch = installFakeBox([
      { events: [{ id: "e1", type: "response", text: askText }], status: { promptRun: { status: "running" } } },
      { events: [{ id: "e1", type: "response", text: askText }], status: { promptRun: { status: "finished", result: askText } } },
    ]);
    await create({ askTimeoutMs: 25 });
    await instance.adapter.sendTurn({ threadId: "t-timeout", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "request.opened");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.find((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "timeout" });
  });

  it("folds a malformed block's correction into the next prompt instead of losing the ask silently", async () => {
    const prompts: string[] = [];
    const badText = "Done.\n\n```omb-ask\n{not json\n```";
    restoreFetch = installFakeBox([
      { events: [{ id: "m1", type: "response", text: badText }], status: { promptRun: { status: "running" } } },
      { events: [{ id: "m1", type: "response", text: badText }], status: { promptRun: { status: "finished", result: badText } } },
      { events: [], status: { promptRun: { status: "finished", result: "Asked again." } } },
    ], prompts);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-malformed", text: "go", integrations: { computer } });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["Done."]);
    await instance.adapter.sendTurn({ threadId: "t-malformed", text: "again", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed" && e !== done);
    expect(prompts[1]).toContain("was malformed or empty");
    expect(prompts[1]).toContain("never saw it");
  });

  it("caps an over-limit block at six questions rather than refusing it", async () => {
    const prompts: string[] = [];
    const askText = askBlock(Array.from({ length: 7 }, (_, i) => ({ question: "Question " + (i + 1) + "?" })));
    restoreFetch = installFakeBox([
      { events: [{ id: "e1", type: "response", text: askText }], status: { promptRun: { status: "running" } } },
      { events: [{ id: "e1", type: "response", text: askText }], status: { promptRun: { status: "finished", result: askText } } },
    ], prompts);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cap", text: "go", integrations: { computer } });
    const opened = (await recorder.until((e) => e.type === "request.opened")) as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened.questions).toHaveLength(6);
    expect(opened.choices).toBeUndefined();
    expect(await instance.adapter.respondToRequest("t-cap", opened.requestId!, { behavior: "deny" })).toBe("rejected");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(prompts).toHaveLength(1); // a deny ends the turn — no continuation
  });

  it("shows only the first block when a reply carries two", async () => {
    const askText = "Hi.\n\n" + askBlock([{ question: "First?" }]) + "\n\n" + askBlock([{ question: "Second?" }]);
    restoreFetch = installFakeBox([
      { events: [{ id: "e1", type: "response", text: askText }], status: { promptRun: { status: "running" } } },
      { events: [{ id: "e1", type: "response", text: askText }], status: { promptRun: { status: "finished", result: askText } } },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-two", text: "go", integrations: { computer } });
    const opened = (await recorder.until((e) => e.type === "request.opened")) as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened.questions?.map((q) => q.question)).toEqual(["First?"]);
    expect(await instance.adapter.respondToRequest("t-two", opened.requestId!, { behavior: "deny" })).toBe("rejected");
    await recorder.until((e) => e.type === "turn.completed");
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["Hi."]);
  });

  it("answers nothing when no ask is held", async () => {
    restoreFetch = installFakeBox([{ events: [], status: { promptRun: { status: "running" } } }]);
    await create();
    expect(await instance.adapter.respondToRequest("t-none", "whatever", { behavior: "answer", message: "hi" })).toBe("unavailable");
  });
});
