import { describe, expect, it, vi, afterEach } from "vitest";
import { PreviewTestingBroker, testingViewport, validateTestingURL } from "./preview-testing.ts";
const input = { botId: "a", botName: "A", name: "Test", url: "http://localhost:3000", source: { kind: "url" as const, url: "http://localhost:3000", raw: "http://localhost:3000", isLocalOrPrivate: true }, width: 390, height: 844, responsive: false, target: "new" as const };
afterEach(() => vi.useRealTimers());
async function opened(broker: PreviewTestingBroker) {
  broker.poll(); const result = broker.open(input); const command = broker.poll().commands[0];
  broker.finish(command.id, { url: input.url }); await result;
  return broker.owned(command.sessionId, "a");
}
describe("Preview testing ownership and cancellation", () => {
  it("requires a desktop heartbeat and scopes sessions to their owner", async () => {
    const broker = new PreviewTestingBroker();
    await expect(broker.open(input)).rejects.toThrow("desktop");
    const session = await opened(broker);
    expect(broker.status("b").sessions).toEqual([]);
    expect(() => broker.owned(session.id, "b")).toThrow("owned");
    broker.control(session.id, "close");
    expect(broker.views()).toEqual([]);
  });
  it("serializes each session; Stop rejects running and queued work and ignores late results", async () => {
    const broker = new PreviewTestingBroker(); const session = await opened(broker);
    const running = broker.execute(session, "wait", {}), queued = broker.execute(session, "click", {});
    const failed1 = expect(running).rejects.toThrow("Stopped"), failed2 = expect(queued).rejects.toThrow("Stopped");
    const [command] = broker.poll().commands;
    expect(broker.poll().commands).toEqual([]);
    broker.control(session.id, "pause");
    await Promise.all([failed1, failed2]);
    expect(broker.finish(command.id, { completed: "click" })).toBe(false);
    expect(() => broker.execute(session, "click", {})).toThrow("stopped");
    broker.control(session.id, "resume");
    const next = broker.execute(session, "snapshot", {}); const [resumed] = broker.poll().commands;
    broker.finish(resumed.id, { title: "Ready" }); expect((await next).title).toBe("Ready");
  });
  it("times out to a stopped lease rather than delivering input later", async () => {
    vi.useFakeTimers(); const broker = new PreviewTestingBroker(() => {}, 1000); const session = await opened(broker);
    const result = broker.execute(session, "click", {}); const rejected = expect(result).rejects.toThrow("timed out");
    vi.advanceTimersByTime(1001); await rejected;
    expect(broker.poll().commands).toEqual([]); expect(session.state).toBe("paused");
  });
  it("expires availability after desktop loss and cancels work on disconnect", async () => {
    vi.useFakeTimers(); const broker = new PreviewTestingBroker(); const session = await opened(broker);
    const result = broker.execute(session, "snapshot", {}); const rejected = expect(result).rejects.toThrow("disconnected");
    broker.disconnect(); await rejected; expect(broker.status("a").available).toBe(false);
  });
  it("validates dimensions and refuses app origins, credentials and non-http navigation", () => {
    expect(testingViewport({ preset: "phone" }).width).toBe(393);
    expect(testingViewport({ preset: "responsive" }).responsive).toBe(true);
    for (const value of [{ width: 0 }, { height: 1e9 }, { width: 400.5 }, { preset: "unknown" }]) expect(() => testingViewport(value)).toThrow();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "http://a:b@example.com", "http://localhost:8899/api/config"]) expect(() => validateTestingURL(url, ["http://127.0.0.1:8899"])).toThrow();
    expect(validateTestingURL("http://localhost:3000")).toBe("http://localhost:3000/");
  });
  it("adopts the attached view's URL and size when targeting the active page", async () => {
    const broker = new PreviewTestingBroker();
    broker.poll(); const result = broker.open({ ...input, url: "about:blank", target: "active" }); const command = broker.poll().commands[0];
    broker.finish(command.id, { url: "https://example.com/cart", source: { kind: "url" }, viewport: { width: 393, height: 852, responsive: false } });
    await result;
    const session = broker.owned(command.sessionId, "a");
    expect(session).toMatchObject({ url: "https://example.com/cart", width: 393, height: 852, target: "active", state: "ready" });
    expect(session.source).toMatchObject({ kind: "url", url: "https://example.com/cart" });
  });
});
