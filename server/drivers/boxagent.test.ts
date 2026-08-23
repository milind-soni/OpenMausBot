// Box agent contract tests against a scripted fake of ascii.dev's box HTTP
// API. The driver polls events + prompt status; the fake advances one poll
// per GET so we can assert message → tool → message order without sleeping.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { BoxAgentDriver } from "./boxagent.ts";

const BOX = "box-1";
const PROMPT = "p1";

/** JSON Response helper for the in-process Box HTTP fake. */
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Poll = { events: unknown[]; status?: { promptRun: { status: string; result?: string } } };

/** Stub fetch so each GET /events + /prompts pair advances one poll in `script`. */
function installFakeBox(script: Poll[]) {
  let i = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/me")) return json({ ok: true });
    if (method === "POST" && /\/boxes\/[^/]+\/prompt$/.test(url)) return json({ promptRun: { id: PROMPT } });
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

  const create = async () => {
    instance = await BoxAgentDriver.create({
      instanceId: "box-test",
      displayName: "Box Test",
      environment: { BOX_TOKEN: "box-test-token" },
      enabled: true,
      config: { pollMs: 0 },
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
});
