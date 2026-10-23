import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { BROWSER_HELD_ELSEWHERE } from "../../../shared/browser-held.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { BrowserService } from "../service.ts";
import { FakeBackend, FakeChrome } from "../testing/fake-chrome.ts";
import { LiveV1 } from "./live-v1.ts";
import { V1_GOLDEN, v1Differences } from "./testing/v1-compare.ts";
import { normalizeV1, runV1Session, SseRecorder } from "./testing/v1-session.ts";

const folders: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ORIGIN = "http://127.0.0.1:43210";

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-live-v1-"));
  folders.push(dataDir);
  const backend = new FakeBackend(() => new FakeChrome({ documents: (url) => ({ title: url.endsWith("/b") ? "Page B" : url.endsWith("/a") ? "Page A" : "", text: url, elements: [{ role: "textbox", name: "Field", editable: true, box: [20, 20, 300, 40] }] }) }));
  const service = new BrowserService({ dataDir, backend: () => backend, maxRunning: 10, idleMs: () => 600_000, takeoverMs: 200 });
  const live = new LiveV1({ service, target: (session) => ({ session, key: `bot:${session}` }) });
  cleanups.push(async () => { live.closeAll(); await service.closeAll(); });
  const open = async (session = "a", owner = "local-owner") => {
    const sse = new SseRecorder();
    await live.open({ botId: "bot", session, owner, isCurrent: () => true, res: sse.response });
    const viewerId = String(sse.events.find((event) => event.type === "ready")?.data.viewerId);
    return { sse, viewerId, action: (body: Record<string, unknown>) => live.action({ viewerId, botId: "bot", owner, body }) };
  };
  return { service, live, backend, open };
}

describe("the v1 live view on the new browser", () => {
  it("sends the events and fields the agent-browser engine sent, for a phone's whole session", async () => {
    const { live, backend } = setup();
    const records = await runV1Session({
      open: (res) => live.open({ botId: "bot", session: "a", owner: "local-owner", isCurrent: () => true, res }),
      action: (viewerId, body) => live.action({ viewerId, botId: "bot", owner: "local-owner", body }),
    }, ORIGIN, { settleMs: 60 });
    const normalized = normalizeV1(records, ORIGIN);
    const shapes = (steps: Array<Record<string, unknown>>) => Object.assign({}, ...steps.map((step) => step.shapes as object));
    expect(shapes(normalized)).toEqual(shapes(V1_GOLDEN as unknown as Array<Record<string, unknown>>));
    expect(v1Differences(normalized).filter((problem) => !problem.includes("picture"))).toEqual([]);
    expect(backend.chrome.sent.some((sent) => sent.method === "Input.insertText" && sent.params.text === "hi")).toBe(true);
  });

  it("holds a slow start's waiting event to the one the agent-browser engine sends while its browser is busy", () => {
    const steps = structuredClone(V1_GOLDEN) as unknown as Array<Record<string, unknown>>;
    const waiting = (shape: unknown) => steps.map((step) => step.step === "open" ? { ...step, shapes: { ...(step.shapes as object), waiting: shape } } : step);
    expect(v1Differences(steps)).toEqual([]);
    expect(v1Differences(waiting({ reason: "string" }))).toEqual([]);
    expect(v1Differences(waiting({ reason: "number" }))).toEqual(['open: waiting carries {"reason":"number"}, the contract {"reason":"string"}']);
    expect(v1Differences(waiting({}).map((step) => step.step === "open" ? { ...step, shapes: { ...(step.shapes as object), stalled: {} } } : step)))
      .toContain("open: an event the v1 contract does not have: stalled");
  });

  it("opens at most two views of one browser and eight in all", async () => {
    const { open } = setup();
    await open("a");
    await open("a");
    await expect(open("a")).rejects.toMatchObject({ status: 429 });
    for (let i = 0; i < 6; i++) await open(`s${i}`);
    await expect(open("other")).rejects.toMatchObject({ status: 429 });
  });

  it("keeps one picture at the phone until it acknowledges it, sending the newest one next", async () => {
    const { open, backend } = setup();
    const { sse, action } = await open();
    const page = [...backend.chrome.pages.values()].at(-1)!;
    const frames = () => sse.events.filter((event) => event.type === "frame");
    await sleep(20);
    const first = frames().length;
    expect(first).toBe(1);
    backend.chrome.paint(page);
    backend.chrome.paint(page);
    await sleep(20);
    expect(frames()).toHaveLength(first);
    await action({ type: "ack", seq: frames().at(-1)!.data.seq });
    await sleep(20);
    expect(frames()).toHaveLength(first + 1);
    expect(Number(frames().at(-1)!.data.seq)).toBe(Number(frames().at(-2)!.data.seq) + 1);
  });

  it("refuses input from a view that does not hold the browser, naming the device that does", async () => {
    const { open } = setup();
    const phone = await open("a", "phone-owner");
    const mac = await open("a", "mac-owner");
    await phone.action({ type: "take" });
    await expect(mac.action({ type: "input_keyboard", eventType: "char", text: "x" })).rejects.toMatchObject({ status: 409, message: BROWSER_HELD_ELSEWHERE });
    await expect(mac.action({ type: "take" })).rejects.toMatchObject({ status: 409, message: BROWSER_HELD_ELSEWHERE });
    const lastControl = [...mac.sse.events].reverse().find((event) => event.type === "control")?.data;
    expect(lastControl).toEqual({ held: true, owned: false, controlling: false });
    await phone.action({ type: "release" });
    expect(await mac.action({ type: "take" })).toEqual({ ok: true, waited: false });
  });

  it("turns a phone's keys into real key events, with Enter's text from the US layout", async () => {
    const { open, backend } = setup();
    const { action } = await open();
    await action({ type: "take" });
    await action({ type: "input_keyboard", eventType: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 });
    await action({ type: "input_keyboard", eventType: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 });
    const keys = backend.chrome.sent.filter((sent) => sent.method === "Input.dispatchKeyEvent").map((sent) => sent.params);
    expect(keys).toContainEqual(expect.objectContaining({ type: "keyDown", key: "Enter", text: "\r", windowsVirtualKeyCode: 13 }));
    expect(keys).toContainEqual(expect.objectContaining({ type: "keyUp", key: "Enter" }));
  });

  it("tells a phone its browser closed unused and ends its view for good, so it does not reconnect and start it again", async () => {
    const { open, service, backend } = setup();
    const { sse } = await open();
    await sleep(25);
    expect(await service.closeIdle(20)).toEqual(["bot:a"]);
    await sleep(20);
    expect(sse.events.filter((event) => event.type === "error").map((event) => event.data)).toEqual([{ retryable: false, asleep: true, message: expect.stringContaining("sat unused") }]);
    expect(sse.writableEnded).toBe(true);
    expect(backend.chromes).toHaveLength(1);
  });

  it("restarts the browser for the person, closes every view of it, and the bot hears it on its next call", async () => {
    const { open, service, backend } = setup();
    const { sse, action } = await open();
    expect(await action({ type: "restart" })).toEqual({ ok: true });
    expect(sse.writableEnded).toBe(true);
    const result = await service.agentRpc({ session: "a", key: "bot:a" }, "tools/call", { name: "agent_browser_status", arguments: {} }) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("The browser was restarted");
    expect(backend.opened.at(-1)?.fresh).toBe(true);
  });
});
