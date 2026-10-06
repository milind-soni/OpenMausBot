import { Children, createElement, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type * as StoreModule from "@/state/store";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalComputerSection } from "./LocalComputerSection";

const fixture = vi.hoisted(() => ({
  config: { localVm: { backend: "cua-spaces", mode: "shared", spacesOs: "linux" } },
  capture: false,
  index: 0,
  values: [] as unknown[],
  status: {} as Record<string, unknown>,
}));

// Seed only this section's hooks; its child components use normal React hooks.
// The production effects are deliberately absent from this handler/markup test.
vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof ReactModule>();
  return {
    ...original,
    useState: (initial: unknown) => {
      if (!fixture.capture) return original.useState(initial);
      const index = fixture.index++;
      if (!(index in fixture.values)) {
        fixture.values[index] = index === 5 ? fixture.status : index === 6 ? false : typeof initial === "function" ? initial() : initial;
      }
      return [fixture.values[index], (next: unknown) => {
        fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
      }];
    },
  };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof StoreModule>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config }, dispatch: vi.fn() }) };
});
vi.mock("./MacLocalControl", () => ({ MacLocalControl: () => null }));

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}

function render() {
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    fixture.capture = true;
    try {
      tree = LocalComputerSection();
    } finally {
      fixture.capture = false;
    }
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  return { html, action: (action: string) => all.find((node) => node.props.action === action) };
}

beforeEach(() => {
  fixture.config = { localVm: { backend: "cua-spaces", mode: "shared", spacesOs: "linux" } };
  fixture.values = [];
  fixture.index = 0;
  fixture.capture = false;
  fixture.status = {
    backend: "cua-spaces", os: "linux", mode: "shared", platform: "darwin", max_instances: 2,
    space_name: "openmausbot-computer-linux", managed: false, container: "missing", ready: false,
    desktopReady: false, create_supported: true, problem: null, image_ref: "test-image", viewer_url: "",
    idle_timeout_ms: 1_800_000,
  };
  vi.stubGlobal("window", { ogb: {}, confirm: vi.fn(() => true) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Cua shared Space settings lifecycle", () => {
  it.each(["shared", "per-bot", "pool"])("offers shared creation only in shared mode, not %s mode", (mode) => {
    fixture.config.localVm.mode = mode;
    fixture.status.mode = mode;
    const rendered = render();
    if (mode === "shared") {
      expect(rendered.html).toContain("Shared Space");
      expect(rendered.action("run")).toBeDefined();
      expect(rendered.action("start")).toBeUndefined();
      expect(rendered.action("remove")).toBeUndefined();
    } else {
      expect(rendered.html).not.toContain("Shared Space");
      expect(rendered.action("run")).toBeUndefined();
      expect(rendered.action("start")).toBeUndefined();
      expect(rendered.action("stop")).toBeUndefined();
      expect(rendered.action("remove")).toBeUndefined();
    }
    expect(rendered.html).not.toContain("Install a container runtime");
  });

  it.each(["per-bot", "pool"])("does not expose shared lifecycle controls from a stale shared snapshot in %s mode", (mode) => {
    fixture.config.localVm.mode = mode;
    fixture.status.mode = "shared";
    expect(render().html).not.toContain("Shared Space");
    expect(render().action("run")).toBeUndefined();
  });

  it.each(["stopped", "running"])("retains an unmanaged %s Space collision problem without lifecycle actions", (container) => {
    Object.assign(fixture.status, { container, managed: false, problem: "An unmanaged Space already uses this name" });
    const rendered = render();
    expect(rendered.html).toContain("An unmanaged Space already uses this name");
    expect(rendered.action("run")).toBeUndefined();
    expect(rendered.action("start")).toBeUndefined();
    expect(rendered.action("stop")).toBeUndefined();
    expect(rendered.action("remove")).toBeUndefined();
  });

  it("offers start, not recreate, for an owned stopped shared Space", () => {
    Object.assign(fixture.status, { container: "stopped", managed: true });
    const rendered = render();
    expect(rendered.action("start")).toBeDefined();
    expect(rendered.action("remove")).toBeDefined();
    expect(rendered.action("run")).toBeUndefined();
    expect(rendered.action("recreate")).toBeUndefined();
  });

  it("keeps the last readiness problem and releases shared Create for a Start retry", async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout as typeof window.setTimeout;
    window.clearTimeout = clearTimeout as typeof window.clearTimeout;
    const started = { ...fixture.status, container: "running", managed: true };
    const last = { ...started, problem: "Guest desktop has not connected" };
    const fetch = vi.fn(async (url: unknown) => new Response(JSON.stringify(String(url).endsWith("/run") ? started : last), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const create = render().action("run")?.props.onClick;
    if (typeof create !== "function") throw new Error("Missing shared Space create action");
    create();
    await vi.advanceTimersByTimeAsync(0);
    const waiting = render();
    expect(waiting.action("start")?.props.pending).toBe("run");
    expect(waiting.html).toContain('disabled=""');
    await vi.advanceTimersByTimeAsync(90_000);
    const timedOut = render();
    expect(timedOut.html).toContain(last.problem);
    // The fixture suppresses loading effects for unrelated inventories. Check
    // this lifecycle control, not their independent aria-busy indicators.
    const start = timedOut.action("start");
    expect(start?.props.pending).toBeNull();
    if (!start) throw new Error("Missing shared Space retry action");
    const startHtml = renderToStaticMarkup(start);
    expect(startHtml).not.toContain('aria-busy="true"');
    expect(startHtml).not.toContain('disabled=""');
    expect(timedOut.action("start")).toBeDefined();
    expect(timedOut.action("run")).toBeUndefined();
    expect(fixture.values[5]).toEqual(last);
    fetch.mockImplementation(async () => new Response(JSON.stringify({ ...last, ready: true, problem: null }), { status: 200 }));
    const retry = timedOut.action("start")?.props.onClick;
    if (typeof retry !== "function") throw new Error("Missing shared Space retry action");
    retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledWith("/api/local-computer/start", expect.objectContaining({ method: "POST" }));
    expect(render().action("start")).toBeUndefined();
    expect(render().html).not.toContain(last.problem);
  });
});
