import { afterEach, describe, expect, it, vi } from "vitest";
import type { JournalEntry } from "./driver-wire.ts";
import { createJournalTap, journalUrl, postJournal } from "./journal-tap.ts";

const call = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "click", arguments: { element_token: "s1-e2" } } });
const reply = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, result: { content: [] } });

afterEach(() => vi.useRealTimers());

describe("journal tap", () => {
  it("posts a call with its slimmed result before the reply is released", async () => {
    let release!: () => void;
    const posted: JournalEntry[] = [];
    const tap = createJournalTap({ post: (entry) => { posted.push(entry); return new Promise<void>((r) => { release = r; }); } });
    tap.request(call(5));
    let done = false;
    const waiting = tap.response(reply(5)).then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    expect(posted).toEqual([{ tool: "click", arguments: { element_token: "s1-e2" }, result: { isError: false } }]);
    release();
    await waiting;
    expect(done).toBe(true);
  });

  it("defaults arguments to an empty object", async () => {
    const posted: JournalEntry[] = [];
    const tap = createJournalTap({ post: async (entry) => { posted.push(entry); } });
    tap.request(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_apps" } }));
    await tap.response(reply(1));
    expect(posted[0].arguments).toEqual({});
  });

  it("releases after timeoutMs when the post hangs, and when it rejects", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const hanging = createJournalTap({ post: (_entry, s) => { signal = s; return new Promise(() => {}); } });
    hanging.request(call(1));
    let done = false;
    void hanging.response(reply(1)).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(signal?.aborted).toBe(true);

    const failing = createJournalTap({ post: () => Promise.reject(new Error("down")) });
    failing.request(call(2));
    let failed = false;
    void failing.response(reply(2)).then(() => { failed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toBe(true);
  });

  it("ignores frames that are not answers to a tools/call", async () => {
    const post = vi.fn(async () => {});
    const tap = createJournalTap({ post });
    tap.request(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    tap.request(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }));
    tap.request("not json");
    await tap.response(reply(1));
    await tap.response(reply(2));
    await tap.response("not json");
    await tap.response(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" }));
    expect(post).not.toHaveBeenCalled();
  });

  it("posts nothing for a call it was told to leave out, and still posts the calls around it", async () => {
    const posted: JournalEntry[] = [];
    const tap = createJournalTap({ post: async (entry) => { posted.push(entry); } });
    for (const id of [1, 2, 3]) tap.request(call(id));
    tap.leaveOut(2);
    tap.leaveOut(null);
    for (const id of [1, 2, 3]) await tap.response(reply(id));
    expect(posted).toHaveLength(2);
  });

  it("derives the journal URL from the control URL", () =>
    expect(journalUrl("http://127.0.0.1:4100/api/internal/computer-control?botId=b1")).toBe("http://127.0.0.1:4100/api/internal/computer/journal"));

  it("lets go of the answer's body once the journal has taken the entry", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream({ pull: () => {}, cancel: cancelled });
    const fetchImpl = vi.fn(async () => new Response(body));
    await postJournal("http://127.0.0.1:1/j", "tok", fetchImpl as unknown as typeof fetch)({ tool: "click", arguments: {}, result: { isError: false } }, new AbortController().signal);
    expect(cancelled).toHaveBeenCalledTimes(1);
    await postJournal("http://127.0.0.1:1/j", "tok", (async () => new Response(null)) as unknown as typeof fetch)(
      { tool: "click", arguments: {}, result: { isError: false } }, new AbortController().signal);
  });

  it("posts JSON with the bearer token and the caller's signal", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const controller = new AbortController();
    const entry: JournalEntry = { tool: "click", arguments: {}, result: { isError: false } };
    await postJournal("http://127.0.0.1:1/j", "tok", fetchImpl as unknown as typeof fetch)(entry, controller.signal);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1/j");
    expect(init).toMatchObject({ method: "POST", signal: controller.signal });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual(entry);
  });
});
