import { afterEach, describe, expect, it, vi } from "vitest";

import { createScreenFrameSource, type ScreenCapture } from "./screen-frame-source.ts";

afterEach(() => vi.restoreAllMocks());

const frame = (png: string) => ({ png, format: "png" });
const publicFrame = (png: string) => ({ png, mime: "image/png" });

function fixture(captures?: { computer?: ScreenCapture; browser?: ScreenCapture }) {
  let time = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => time);
  const control = { held: false, revision: 0 };
  const computer = vi.fn(async () => frame("desktop"));
  const browser = vi.fn(async () => frame("page"));
  const onFrame = vi.fn();
  const source = createScreenFrameSource({
    captures: captures ?? { computer, browser },
    control: () => ({ ...control }),
    onFrame,
    minGapMs: 3000,
  });
  return { source, computer, browser, control, onFrame, advance: (ms: number) => { time += ms; } };
}

describe("screen frame source", () => {
  it("throttles previews on one surface, but takes a fresh settled frame", async () => {
    const { source, computer, advance } = fixture();
    await source.capture();
    advance(1);
    await source.capture();
    expect(computer).toHaveBeenCalledTimes(1);
    computer.mockResolvedValue(frame("settled desktop"));
    await source.capture(true);
    expect(computer).toHaveBeenCalledTimes(2);
    expect(source.last).toEqual(publicFrame("settled desktop"));
  });

  it("switches to the browser inside the desktop preview's throttle window", async () => {
    const { source, browser, advance } = fixture();
    await source.capture();
    advance(1);
    source.surface = "browser";
    expect(source.last).toBeNull();
    await source.capture();
    expect(browser).toHaveBeenCalledTimes(1);
    expect(source.last).toEqual(publicFrame("page"));
  });

  it("waits for an in-flight desktop frame, discards it, then settles the browser", async () => {
    let resolveDesktop!: (frame: { png: string; format: string }) => void;
    const computer = vi.fn(() => new Promise<{ png: string; format: string }>((resolve) => { resolveDesktop = resolve; }));
    const browser = vi.fn(async () => frame("page"));
    const { source, onFrame } = fixture({ computer, browser });
    const oldCapture = source.capture();
    source.surface = "browser";
    const settled = source.capture(true);
    expect(browser).not.toHaveBeenCalled();
    resolveDesktop(frame("stale desktop"));
    await Promise.all([oldCapture, settled]);
    expect(source.last).toEqual(publicFrame("page"));
    expect(onFrame.mock.calls).toEqual([[publicFrame("page")]]);
  });

  it("also switches from the browser back to the desktop", async () => {
    const { source } = fixture();
    source.surface = "browser";
    await source.capture();
    source.surface = "computer";
    await source.capture(true);
    expect(source.last).toEqual(publicFrame("desktop"));
  });

  it("does not use an old desktop as fallback when the selected browser fails", async () => {
    const { source, browser } = fixture();
    await source.capture();
    browser.mockRejectedValue(new Error("browser unavailable"));
    source.surface = "browser";
    await source.capture(true);
    expect(source.last).toBeNull();
  });

  it("serializes concurrent preview requests even while switching surfaces", async () => {
    const { source, computer } = fixture();
    await Promise.all([source.capture(), source.capture(), source.capture()]);
    expect(computer).toHaveBeenCalledTimes(1);
  });

  it("never captures while the human holds control, even for a settled frame", async () => {
    const { source, computer, control } = fixture();
    control.held = true;
    await source.capture(true);
    expect(computer).not.toHaveBeenCalled();
    expect(source.last).toBeNull();
  });

  it("discards a frame if human control changed while it was in flight", async () => {
    const { source, computer, control, onFrame } = fixture();
    computer.mockImplementation(async () => {
      control.revision += 2;
      return frame("private");
    });
    await source.capture(true);
    expect(source.last).toBeNull();
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("keeps the only available surface usable", async () => {
    const { source } = fixture({ browser: async () => frame("only browser") });
    expect(source.surface).toBe("browser");
    await source.capture(true);
    expect(source.last).toEqual(publicFrame("only browser"));
  });
});
