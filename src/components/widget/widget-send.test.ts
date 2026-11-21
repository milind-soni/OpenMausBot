// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendWidgetAction, type WidgetPress } from "./widget-send";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const press: WidgetPress = { botId: "scout", threadId: "t1", messageId: "w1", ref: "n3", rev: 0, sendId: "s1" };

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => reply(200, { ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendWidgetAction", () => {
  it("returns the server's openThread answer for a posted device press", async () => {
    fetchMock.mockImplementation(async () => reply(202, { ok: true, threadId: "t1", openThread: { botId: "other", threadId: "t-routine" } }));
    await expect(sendWidgetAction(press)).resolves.toEqual({ ok: true, device: { openThread: { botId: "other", threadId: "t-routine" } } });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).widgetAction).toEqual({ messageId: "w1", ref: "n3", rev: 0 });
  });

  it("returns the server's openUrl answer", async () => {
    fetchMock.mockImplementation(async () => reply(202, { ok: true, threadId: "t1", openUrl: "https://mausbot.com/docs" }));
    await expect(sendWidgetAction(press)).resolves.toEqual({ ok: true, device: { openUrl: "https://mausbot.com/docs" } });
  });

  it("returns no device answer for an ordinary press", async () => {
    await expect(sendWidgetAction(press)).resolves.toEqual({ ok: true });
  });

  it("ignores a malformed device answer instead of navigating on it", async () => {
    fetchMock.mockImplementation(async () => reply(202, { ok: true, threadId: "t1", openThread: { botId: "scout", threadId: "not a thread id" } }));
    await expect(sendWidgetAction(press)).resolves.toEqual({ ok: true });
  });

  it("reports a refused press with the server's sentence", async () => {
    fetchMock.mockImplementation(async () => reply(404, { error: "That conversation is no longer here." }));
    await expect(sendWidgetAction(press)).resolves.toEqual({ ok: false, refused: true, error: "That conversation is no longer here." });
  });

  it("reports a press that got no answer as retryable", async () => {
    fetchMock.mockImplementationOnce(async () => { throw new TypeError("Failed to fetch"); });
    await expect(sendWidgetAction(press)).resolves.toEqual({ ok: false, refused: false });
  });
});
