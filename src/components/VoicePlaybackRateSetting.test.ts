// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  dispatch: vi.fn(),
  config: { tts: { playbackRate: 1 } } as Record<string, unknown>,
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

const { VoicePlaybackRateSetting } = await import("./VoicePlaybackRateSetting");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fixture.config = { tts: { playbackRate: 1 } };
  fixture.api.mockResolvedValue({ tts: { playbackRate: 1.5 } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("VoicePlaybackRateSetting", () => {
  it("saves the selected installation speed", async () => {
    await act(async () => root.render(createElement(VoicePlaybackRateSetting)));
    const select = host.querySelector("select")!;
    expect(select.value).toBe("1");
    await act(async () => {
      select.value = "1.5";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PUT",
      body: JSON.stringify({ tts: { playbackRate: 1.5 } }),
    });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { tts: { playbackRate: 1.5 } } });
  });
});
