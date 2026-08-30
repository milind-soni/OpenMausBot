import { describe, expect, it } from "vitest";
import {
  aspectFitNativeViewBounds,
  initialLocalVmWorkspaceSlots,
  nativeViewOverlayIntersects,
  readyLocalVmViewerUrl,
  reconcileLocalVmWorkspaceSlots,
  releaseLocalVmWorkspaceControl,
  sanitizeLocalVmWorkspaceStatus,
  selectLocalVmWorkspaceSlot,
  switchLocalVmWorkspaceControl,
} from "./local-vm-workspace";

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

const bots = [
  { id: "vm-a", computer: "vm" as const },
  { id: "vm-b", computer: "vm" as const },
  { id: "vm-c", computer: "vm" as const },
  { id: "cloud", computer: "cloud" as const },
  { id: "hidden", computer: "vm" as const, hidden: true },
];

describe("Local VM native overlay shielding", () => {
  it("checks overlays against the fitted native surface, not its letterbox", () => {
    const fitted = aspectFitNativeViewBounds({ x: 0, y: 0, width: 1_000, height: 500 }, 1.6);
    const hosts = [rect(fitted.x, fitted.y, fitted.width, fitted.height)];

    expect(fitted).toEqual({ x: 100, y: 0, width: 800, height: 500 });
    expect(nativeViewOverlayIntersects(hosts, [{
      rect: rect(0, 0, 80, 500),
      explicit: true,
      visible: true,
      zIndex: 40,
    }])).toBe(false);
  });

  it("hides panes only for visible intersecting overlays", () => {
    const hosts = [rect(100, 100, 400, 300)];
    expect(
      nativeViewOverlayIntersects(hosts, [
        { rect: rect(150, 120, 100, 80), explicit: true, visible: true, zIndex: null },
      ]),
    ).toBe(true);
    expect(
      nativeViewOverlayIntersects(hosts, [
        { rect: rect(10, 10, 40, 40), explicit: true, visible: true, zIndex: null },
        { rect: rect(150, 120, 100, 80), explicit: false, visible: true, zIndex: 9 },
        { rect: rect(150, 120, 100, 80), explicit: true, visible: false, zIndex: 50 },
      ]),
    ).toBe(false);
    expect(
      nativeViewOverlayIntersects(hosts, [
        { rect: rect(450, 350, 100, 100), explicit: false, visible: true, zIndex: 20 },
      ]),
    ).toBe(true);
  });
});

describe("Local VM workspace slots", () => {
  it("starts with the selected VM on the left and another eligible VM on the right", () => {
    expect(initialLocalVmWorkspaceSlots(bots, "vm-b")).toEqual(["vm-b", "vm-a"]);
  });

  it("swaps a duplicate selection instead of showing one bot twice", () => {
    expect(selectLocalVmWorkspaceSlot(["vm-a", "vm-b"], 0, "vm-b")).toEqual([
      "vm-b",
      "vm-a",
    ]);
  });

  it("removes deleted or ineligible bots and fills from remaining VM bots", () => {
    expect(reconcileLocalVmWorkspaceSlots(["vm-a", "vm-b"], bots.slice(1))).toEqual([
      "vm-c",
      "vm-b",
    ]);
  });
});

describe("Local VM workspace control", () => {
  function port({ held = false, owned = false } = {}) {
    const calls: string[] = [];
    return {
      calls,
      value: {
        async take(botId: string) {
          calls.push(`take:${botId}`);
          if (held) return { held: true, helpReason: null, owned, acquired: false };
          held = true;
          owned = true;
          return { held: true, helpReason: null, owned: true, acquired: true };
        },
        async release(botId: string) {
          calls.push(`release:${botId}`);
          if (!owned) return { held, helpReason: null, released: false };
          held = false;
          owned = false;
          return { held: false, helpReason: null, released: true };
        },
        async setInteractive(contextId: string | null) {
          calls.push(`interactive:${contextId ?? "none"}`);
          return true;
        },
      },
    };
  }

  it("releases and demotes the old pane before taking the next pane", async () => {
    const fixture = port();
    const result = await switchLocalVmWorkspaceControl(
      fixture.value,
      "vm-a",
      "vm-b",
      "right",
    );
    expect(result.status).toBe("controlled");
    expect(fixture.calls).toEqual([
      "interactive:none",
      "release:vm-a",
      "take:vm-b",
      "interactive:right",
    ]);
  });

  it("atomically observes a pane already held outside the workspace", async () => {
    const fixture = port({ held: true, owned: false });
    const result = await switchLocalVmWorkspaceControl(fixture.value, null, "vm-b", "right");
    expect(result.status).toBe("held-elsewhere");
    expect(fixture.calls).toEqual(["take:vm-b"]);
  });

  it("releases only a workspace-owned current pane during close", async () => {
    const fixture = port({ held: true, owned: true });
    await releaseLocalVmWorkspaceControl(fixture.value, null);
    expect(fixture.calls).toEqual([]);
    await releaseLocalVmWorkspaceControl(fixture.value, "vm-a");
    expect(fixture.calls).toEqual(["interactive:none", "release:vm-a"]);
  });

  it("releases the API hold even when native demotion fails", async () => {
    const fixture = port({ held: true, owned: true });
    fixture.value.setInteractive = async (contextId: string | null) => {
      fixture.calls.push(`interactive:${contextId ?? "none"}`);
      throw new Error("native viewer unavailable");
    };

    await expect(releaseLocalVmWorkspaceControl(fixture.value, "vm-a")).resolves.toMatchObject({
      held: false,
      released: true,
    });
    expect(fixture.calls).toEqual(["interactive:none", "release:vm-a"]);
  });

  it("revalidates and restores the same workspace-owned pane", async () => {
    const fixture = port({ held: true, owned: true });
    const result = await switchLocalVmWorkspaceControl(fixture.value, "vm-a", "vm-a", "left");
    expect(result.status).toBe("controlled");
    expect(fixture.calls).toEqual(["take:vm-a", "interactive:left"]);
  });

  it("demotes before releasing a newly taken hold when promotion fails", async () => {
    const fixture = port();
    fixture.value.setInteractive = async (contextId: string | null) => {
      fixture.calls.push(`interactive:${contextId ?? "none"}`);
      if (contextId === "right") throw new Error("viewer failed");
      return true;
    };
    await expect(
      switchLocalVmWorkspaceControl(fixture.value, null, "vm-b", "right"),
    ).rejects.toThrow("viewer failed");
    expect(fixture.calls).toEqual([
      "take:vm-b",
      "interactive:right",
      "interactive:none",
      "release:vm-b",
    ]);
  });
});

describe("Local VM workspace status", () => {
  const ready = {
    mode: "per-bot",
    max_instances: 2,
    container: "running",
    network: "loopback",
    security: "hardened",
    persistence: "durable",
    desktopReady: true,
    ready: true,
    viewer_url: "http://127.0.0.1:6080/vnc.html#password=secret",
    problem: "must not enter state",
  };

  it("retains only normalized readiness facts and drops URL and arbitrary text", () => {
    const status = sanitizeLocalVmWorkspaceStatus(ready);
    expect(status).toEqual({
      mode: "per-bot",
      maxInstances: 2,
      container: "running",
      network: "loopback",
      security: "hardened",
      persistence: "durable",
      desktopReady: true,
      ready: true,
    });
    expect(status).not.toHaveProperty("viewer_url");
    expect(status).not.toHaveProperty("problem");
  });

  it("fails closed when any required readiness guard is unsafe", () => {
    expect(sanitizeLocalVmWorkspaceStatus({ ...ready, network: "unsafe" }).ready).toBe(false);
    expect(sanitizeLocalVmWorkspaceStatus({ ...ready, desktopReady: false }).ready).toBe(false);
    expect(readyLocalVmViewerUrl({ ...ready, security: "unsafe" })).toBeNull();
  });

  it("returns a ready URL only for the immediate native-view handoff", () => {
    expect(readyLocalVmViewerUrl(ready)).toBe(ready.viewer_url);
  });
});
