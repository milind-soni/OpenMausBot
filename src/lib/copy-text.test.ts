import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPY_FEEDBACK_MS, WEB_WRITE_TIMEOUT_MS, copyText, createCopyFeedback, type CopyFeedback, type CopyResult } from "./copy-text";

const setEnv = (writeText: ((t: string) => Promise<void>) | undefined, bridge?: (t: string) => Promise<boolean>) => {
  vi.stubGlobal("navigator", writeText ? { clipboard: { writeText } } : {});
  vi.stubGlobal("window", { ogb: bridge ? { copyText: bridge } : undefined });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("copyText", () => {
  it("awaits the web clipboard and reports success without touching the bridge", async () => {
    const writeText = vi.fn(async () => {});
    const bridge = vi.fn(async () => true);
    setEnv(writeText, bridge);
    expect(await copyText("hello")).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(bridge).not.toHaveBeenCalled();
  });

  it("falls back to the Electron bridge when the web clipboard rejects", async () => {
    const bridge = vi.fn(async () => true);
    setEnv(async () => { throw new DOMException("denied", "NotAllowedError"); }, bridge);
    expect(await copyText("hello")).toBe("copied");
    expect(bridge).toHaveBeenCalledWith("hello");
  });

  it("falls back to the bridge when navigator.clipboard is absent (insecure context)", async () => {
    const bridge = vi.fn(async () => true);
    setEnv(undefined, bridge);
    expect(await copyText("hello")).toBe("copied");
  });

  it("reports failure when the web clipboard rejects and no bridge exists", async () => {
    setEnv(async () => { throw new Error("denied"); });
    expect(await copyText("hello")).toBe("failed");
  });

  it("reports failure when the bridge declines or throws", async () => {
    setEnv(async () => { throw new Error("denied"); }, async () => false);
    expect(await copyText("x")).toBe("failed");
    setEnv(async () => { throw new Error("denied"); }, async () => { throw new Error("ipc"); });
    expect(await copyText("x")).toBe("failed");
  });

  it("treats empty or blank text as empty and writes nothing", async () => {
    const writeText = vi.fn(async () => {});
    const bridge = vi.fn(async () => true);
    setEnv(writeText, bridge);
    expect(await copyText("")).toBe("empty");
    expect(await copyText("  \n ")).toBe("empty");
    expect(writeText).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });
});

describe("createCopyFeedback", () => {
  beforeEach(() => vi.useFakeTimers());

  const setup = (copy: (t: string) => Promise<CopyResult>) => {
    const states: CopyFeedback[] = [];
    const feedback = createCopyFeedback({ copy, onChange: (s) => states.push(s) });
    return { states, feedback };
  };

  it("shows copied then restores idle after the delay", async () => {
    const { states, feedback } = setup(async () => "copied");
    await feedback.click("a");
    expect(states).toEqual(["copied"]);
    vi.advanceTimersByTime(COPY_FEEDBACK_MS - 1);
    expect(states).toEqual(["copied"]);
    vi.advanceTimersByTime(1);
    expect(states).toEqual(["copied", "idle"]);
  });

  it("shows failed then restores idle", async () => {
    const { states, feedback } = setup(async () => "failed");
    await feedback.click("a");
    vi.advanceTimersByTime(COPY_FEEDBACK_MS);
    expect(states).toEqual(["failed", "idle"]);
  });

  it("converts a throwing copy into failed feedback instead of an unhandled rejection", async () => {
    const { states, feedback } = setup(async () => { throw new Error("boom"); });
    await feedback.click("a");
    expect(states).toEqual(["failed"]);
  });

  it("empty text gives no feedback", async () => {
    const { states, feedback } = setup(async () => "empty");
    expect(await feedback.click("")).toBe("empty");
    vi.advanceTimersByTime(5000);
    expect(states).toEqual([]);
  });

  it("ignores a second click while a write is in flight", async () => {
    let release!: () => void;
    const copy = vi.fn(() => new Promise<CopyResult>((resolve) => { release = () => resolve("copied"); }));
    const { states, feedback } = setup(copy);
    const first = feedback.click("a");
    expect(await feedback.click("a")).toBe("busy");
    expect(copy).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(states).toEqual(["copied"]);
  });

  it("a click after settling restarts the reset timer rather than racing the old one", async () => {
    const { states, feedback } = setup(async () => "copied");
    await feedback.click("a");
    vi.advanceTimersByTime(1000);
    await feedback.click("a");
    vi.advanceTimersByTime(1000); // old timer would have fired at 1200
    expect(states).toEqual(["copied", "copied"]);
    vi.advanceTimersByTime(COPY_FEEDBACK_MS);
    expect(states).toEqual(["copied", "copied", "idle"]);
  });

  it("does not update after dispose, even if the write resolves late", async () => {
    let release!: () => void;
    const { states, feedback } = setup(() => new Promise<CopyResult>((resolve) => { release = () => resolve("copied"); }));
    const pending = feedback.click("a");
    feedback.dispose();
    release();
    await pending;
    vi.advanceTimersByTime(5000);
    expect(states).toEqual([]);
  });
});

describe("a web write that never settles", () => {
  beforeEach(() => vi.useFakeTimers());

  const hung = () => {
    let resolveLate!: () => void;
    let rejectLate!: (error: Error) => void;
    const writeText = vi.fn(() => new Promise<void>((resolve, reject) => { resolveLate = resolve; rejectLate = reject; }));
    return { writeText, resolveLate: () => resolveLate(), rejectLate: (error: Error) => rejectLate(error) };
  };

  it("times out and uses the bridge", async () => {
    const web = hung();
    const bridge = vi.fn(async () => true);
    setEnv(web.writeText, bridge);
    const result = copyText("hello");
    await vi.advanceTimersByTimeAsync(WEB_WRITE_TIMEOUT_MS - 1);
    expect(bridge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("copied");
    expect(bridge).toHaveBeenCalledWith("hello");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out to failed when there is no bridge", async () => {
    const web = hung();
    setEnv(web.writeText);
    const result = copyText("hello");
    await vi.advanceTimersByTimeAsync(WEB_WRITE_TIMEOUT_MS);
    expect(await result).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the settled outcome when the web write resolves or rejects late", async () => {
    const web = hung();
    setEnv(web.writeText, async () => false);
    const states: CopyFeedback[] = [];
    const feedback = createCopyFeedback({ copy: copyText, onChange: (s) => states.push(s) });
    const click = feedback.click("hello");
    await vi.advanceTimersByTimeAsync(WEB_WRITE_TIMEOUT_MS);
    expect(await click).toBe("failed");
    expect(states).toEqual(["failed"]);
    web.resolveLate();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(["failed"]);

    const rejecting = hung();
    setEnv(rejecting.writeText);
    const second = copyText("hello");
    await vi.advanceTimersByTimeAsync(WEB_WRITE_TIMEOUT_MS);
    expect(await second).toBe("failed");
    rejecting.rejectLate(new Error("late"));
    await vi.advanceTimersByTimeAsync(0); // an unhandled rejection would fail the run
  });

  it("a second click while the hung write is pending is busy, and works after it settles", async () => {
    const web = hung();
    setEnv(web.writeText, async () => true);
    const states: CopyFeedback[] = [];
    const feedback = createCopyFeedback({ copy: copyText, onChange: (s) => states.push(s) });
    const first = feedback.click("a");
    expect(await feedback.click("a")).toBe("busy");
    expect(web.writeText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WEB_WRITE_TIMEOUT_MS);
    expect(await first).toBe("copied");
    expect(states).toEqual(["copied"]);
    const again = feedback.click("a"); // not stuck busy: a new attempt starts (and times out the same way)
    expect(web.writeText).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(WEB_WRITE_TIMEOUT_MS);
    expect(await again).toBe("copied");
  });

  it("dispose during the timeout means no late onChange", async () => {
    const web = hung();
    setEnv(web.writeText, async () => true);
    const states: CopyFeedback[] = [];
    const feedback = createCopyFeedback({ copy: copyText, onChange: (s) => states.push(s) });
    const click = feedback.click("a");
    await vi.advanceTimersByTimeAsync(WEB_WRITE_TIMEOUT_MS - 1000);
    feedback.dispose();
    await vi.advanceTimersByTimeAsync(WEB_WRITE_TIMEOUT_MS * 2);
    await click;
    expect(states).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
