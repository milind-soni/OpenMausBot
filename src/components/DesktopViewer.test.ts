import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopViewer } from "./DesktopViewer";

const { effects, rfb, client } = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  rfb: vi.fn(), client: { addEventListener: vi.fn(), disconnect: vi.fn() },
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => string) => snapshot(),
}));
vi.mock("@novnc/novnc", () => ({ default: rfb }));
vi.mock("./MenuMotion", () => ({
  useHeldMenuMotion: (value: unknown) => ({ value, shown: false }), useMenuMotion: () => ({ shown: false }),
}));
vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));

let cleanups: Array<() => void>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  effects.length = 0; cleanups = [];
  rfb.mockReset().mockImplementation(function () { return client; });
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ password: "computer-password" }) });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { title: "Fixture", fullscreenEnabled: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("location", { hash: "", href: "https://workspace.example/desktop-viewer", protocol: "https:" });
});
afterEach(() => {
  cleanups.forEach(cleanup => cleanup());
  vi.unstubAllGlobals();
});
function render(target: string, threadId?: string) {
  location.hash = `#${new URLSearchParams({ target, ...(threadId ? { threadId } : {}) })}`;
  renderToStaticMarkup(createElement(DesktopViewer));
  for (const effect of effects) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
}

it.each(["orgo/test-bot", "vps/test-bot"])("joins %s and connects through the authenticated app origin", async target => {
  render(target, "thread-1");
  await expect.poll(() => rfb.mock.calls.length).toBe(1);
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
    "/api/bots/test-bot/computer/join?threadId=thread-1", `/api/desktop-viewer/${target}`,
  ]);
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: "{}" });
  expect(fetchMock.mock.calls[1][1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  expect(rfb.mock.calls[0][1]).toBe(`wss://workspace.example/api/desktop-viewer/${target}/websockify`);
  expect(rfb.mock.calls[0][2]).toMatchObject({ credentials: { password: "computer-password" } });
  expect(rfb.mock.calls[0][1]).not.toContain("computer-password");
});

it.each(["orgo/../other", "orgo/https://evil.example", "orgo/test-bot/other", "orgo/"])("refuses malformed target %s without a request", target => {
  render(target);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(rfb).not.toHaveBeenCalled();
});
