// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.fn();
vi.mock("@/state/api", () => ({ api: (...args: unknown[]) => api(...args) }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true }));
const { ToolActivity } = await import("./ToolActivity");

const source = { threadId: "th1", messageId: "m1" };
const preview = "a".repeat(1_000);
const whole = `${preview}${"b".repeat(5_000)}`;
let root: Root; let host: HTMLDivElement;

beforeEach(() => { api.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = (tool: Record<string, unknown>) => act(() => root.render(createElement(ToolActivity, { tool: { name: "Bash", ok: true, ...tool }, source })));
const toggle = async (open: boolean) => {
  const details = host.querySelector("details")!;
  await act(async () => { details.open = open; details.dispatchEvent(new Event("toggle")); });
};
const shown = () => [...host.querySelectorAll("pre")].at(-1)?.textContent;

describe("ToolActivity: a clipped step", () => {
  it("loads its whole output once, when first opened", async () => {
    api.mockResolvedValue({ output: whole });
    render({ output: preview, clipped: true });
    expect(api).not.toHaveBeenCalled();
    await toggle(true);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0]![0]).toBe("/api/threads/th1/messages/m1/tool");
    expect(shown()).toBe(whole);
    expect(host.textContent).not.toContain("Loading the full result");
    await toggle(false);
    await toggle(true);
    expect(api).toHaveBeenCalledTimes(1);
    expect(shown()).toBe(whole);
  });

  it("shows the start with a note while loading, and if loading fails", async () => {
    let fail!: (error: Error) => void;
    api.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    render({ output: preview, clipped: true });
    await toggle(true);
    expect(shown()).toBe(preview);
    expect(host.textContent).toContain("Loading the full result");
    await act(async () => fail(new Error("offline")));
    expect(shown()).toBe(preview);
    expect(host.textContent).toContain("Showing the start of the result only");
  });

  it("asks again after being closed mid-load", async () => {
    api.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce({ output: whole });
    render({ output: preview, clipped: true });
    await toggle(true);
    await toggle(false);
    await toggle(true);
    expect(api).toHaveBeenCalledTimes(2);
    expect(shown()).toBe(whole);
  });

  it("never fetches a step that came whole", async () => {
    render({ output: "all of it" });
    await toggle(true);
    expect(api).not.toHaveBeenCalled();
    expect(shown()).toBe("all of it");
  });
});
