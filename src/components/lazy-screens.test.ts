// @vitest-environment happy-dom
// Screens that open only on request load as their own chunks, off the
// launch path. Once fetched, a screen renders in the same commit as the
// click, exactly as when it was part of the entry; React.lazy would suspend
// on every first render and React then holds that commit for up to 300 ms.
// A chunk that cannot load never throws into the tree, which has no error
// boundary. Chromium (so Electron) keeps a failed import for the life of the
// page and rejects every later import() of it at once, so the screen says it
// could not load and offers a reload instead of showing nothing.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const screens = await import("./lazy-screens");
const { lazyScreen, preloadScreens } = screens;
/** Every deferred screen's preload, stubbed so no test fetches a real chunk. */
const stubPreloads = () => Object.values(screens)
  .filter((value): value is ReturnType<typeof lazyScreen> => typeof value === "function" && "preload" in value)
  .map((screen) => vi.spyOn(screen, "preload").mockResolvedValue(() => null));

let root: Root | null = null;
function render(element: ReturnType<typeof createElement>) {
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  flushSync(() => root!.render(element));
  return document.body.innerHTML;
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const Label = ({ text }: { text: string }) => createElement("p", null, text);
type Loaded = Promise<typeof Label>;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("lazyScreen", () => {
  it("renders an already fetched screen in the same commit that mounts it", async () => {
    const Screen = lazyScreen("Settings", async () => Label);
    await Screen.preload();
    expect(render(createElement(Screen, { text: "Settings" }))).toBe("<div><p>Settings</p></div>");
  });

  it("renders nothing before its chunk arrives, then the screen", async () => {
    let arrive!: (component: typeof Label) => void;
    const load = vi.fn((): Loaded => new Promise((resolve) => (arrive = resolve)));
    const Screen = lazyScreen("Routines", load);
    expect(render(createElement(Screen, { text: "Routines" }))).toBe("<div></div>");
    arrive(Label);
    await settle();
    expect(document.body.innerHTML).toBe("<div><p>Routines</p></div>");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("fetches a chunk once, however many places ask for it", async () => {
    const load = vi.fn(async () => Label);
    const Screen = lazyScreen("Inspector", load);
    render(createElement("div", null, createElement(Screen, { text: "a" }), createElement(Screen, { text: "b" })));
    await Promise.all([Screen.preload(), Screen.preload()]);
    await settle();
    expect(document.body.textContent).toBe("ab");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the screen's own state across re-renders once it has loaded", async () => {
    let mounts = 0;
    const Counter = ({ text }: { text: string }) => {
      const [id] = useState(() => ++mounts);
      return createElement("p", null, `${text}${id}`);
    };
    const Screen = lazyScreen("Counter", async () => Counter);
    render(createElement(Screen, { text: "x" }));
    await settle();
    render(createElement(Screen, { text: "y" }));
    expect(document.body.textContent).toBe("y1");
    expect(mounts).toBe(1);
  });

  // What Chromium does: the first import() fails, and every later one rejects
  // straight away from the module map without fetching again.
  it("a chunk that keeps failing shows a reload notice for that screen only, and logs it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const load = vi.fn((): Loaded => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
    const Screen = lazyScreen("TeamMapPage", load);
    await expect(Screen.preload()).rejects.toThrow(TypeError);
    render(createElement("main", null, "chat", createElement(Screen, { text: "Team map" })));
    await settle();
    expect(document.querySelector("main")!.outerHTML).toBe("<main>chat</main>");
    const notice = document.querySelector<HTMLElement>('[role="alert"]');
    expect(notice?.textContent).toContain("couldn’t load");
    expect(document.body.textContent).not.toContain("Team map");
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledTimes(2);
    expect(String(warnings.mock.calls[0]![0])).toContain("TeamMapPage");
    expect(reload).not.toHaveBeenCalled();
    notice!.querySelector("button")!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("logs a failed prefetch rather than dropping it silently", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new TypeError("Failed to fetch dynamically imported module");
    const Screen = lazyScreen("SettingsModal", (): Loaded => Promise.reject(failure));
    await expect(Screen.preload()).rejects.toBe(failure);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("SettingsModal"), failure);
  });

  it("the next open asks once more, so a browser that fetches it again recovers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const load = vi.fn<() => Loaded>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"))
      .mockResolvedValue(Label);
    const Screen = lazyScreen("TriggersPanel", load);
    render(createElement(Screen, { text: "Triggers" }));
    await settle();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    render(createElement("p"));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    render(createElement(Screen, { text: "Triggers" }));
    await settle();
    expect(document.body.textContent).toBe("Triggers");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("asks once per open and never polls, since a cached failure cannot recover by asking", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const load = vi.fn(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
    const Screen = lazyScreen("ComputerPanel", load);
    render(createElement(Screen, {}));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a screen closed before its chunk fails leaves nothing behind", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail!: (error: Error) => void;
    const Screen = lazyScreen("ActivityPanel", (): Loaded => new Promise((_, reject) => (fail = reject)));
    render(createElement(Screen, { text: "Activity" }));
    render(createElement("p", null, "chat"));
    fail(new TypeError("Failed to fetch dynamically imported module"));
    await settle();
    expect(document.body.innerHTML).toBe("<div><p>chat</p></div>");
  });
});

describe("preloadScreens", () => {
  it("fetches every deferred screen once the launch is idle, and can be cancelled", () => {
    let idle: (() => void) | undefined;
    const cancel = vi.fn();
    vi.stubGlobal("requestIdleCallback", (run: () => void, options: { timeout: number }) => {
      expect(options.timeout).toBeGreaterThan(0);
      idle = run;
      return 7;
    });
    vi.stubGlobal("cancelIdleCallback", cancel);
    const preloads = stubPreloads();
    expect(preloads.length).toBe(13);
    const stop = preloadScreens();
    for (const preload of preloads) expect(preload).not.toHaveBeenCalled();
    idle!();
    for (const preload of preloads) expect(preload).toHaveBeenCalledTimes(1);
    stop();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it("falls back to a timer where requestIdleCallback is missing", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const preloads = stubPreloads();
    preloadScreens();
    for (const preload of preloads) expect(preload).not.toHaveBeenCalled();
    vi.runAllTimers();
    for (const preload of preloads) expect(preload).toHaveBeenCalledTimes(1);
  });

  it("a window opened onto Settings fetches Settings at once, not when idle", async () => {
    let settingsFetched = false;
    vi.resetModules();
    vi.doMock("./SettingsModal", () => {
      settingsFetched = true;
      return { SettingsModal: () => null };
    });
    window.history.replaceState(null, "", "/?desktop-settings=workspaces");
    try {
      await import("./lazy-screens");
      await vi.dynamicImportSettled();
      expect(settingsFetched).toBe(true);
    } finally {
      vi.doUnmock("./SettingsModal");
      window.history.replaceState(null, "", "/");
    }
  });
});

// The launch path is whatever src/main.tsx reaches through static imports;
// Rollup splits a module out only when nothing on that path imports it.
describe("launch bundle", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const resolve = (from: string, specifier: string) => {
    const base = specifier.startsWith("@/") ? join(srcRoot, specifier.slice(2))
      : specifier.startsWith(".") ? join(dirname(from), specifier) : null;
    if (!base) return null;
    for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
      if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
    }
    return null;
  };
  const staticImports = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']/g;
  const launchModules = () => {
    const seen = new Set<string>();
    const queue = [join(srcRoot, "main.tsx")];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const [, specifier] of readFileSync(file, "utf8").matchAll(staticImports)) {
        const target = resolve(file, specifier!);
        if (target) queue.push(target);
      }
    }
    // join() writes backslashes on Windows; name the modules with forward slashes everywhere.
    return new Set([...seen].map((file) => file.slice(srcRoot.length + 1).split(sep).join("/")));
  };

  it("leaves the on-request screens out of it", () => {
    const reached = launchModules();
    expect(reached.has("App.tsx")).toBe(true);
    expect(reached.has("components/Sidebar.tsx")).toBe(true);
    const deferred = [
      "ActivityPanel", "BotSettingsDialog", "ComputerPanel", "InspectorPanel", "KeyboardShortcutsModal",
      "LocalVmWorkspace", "NewBotDialog", "RemoteAgentSettingsPanel", "remote-desktop-panel", "RoutineCalendarPage",
      "RoutinesPage", "SettingsModal", "TeamMapPage", "TriggersPanel",
    ].map((name) => `components/${name}.tsx`);
    expect(deferred.filter((file) => reached.has(file))).toEqual([]);
  });
});
