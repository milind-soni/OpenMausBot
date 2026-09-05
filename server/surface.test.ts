// Where a turn's hands land. The policy is small but every branch was a
// real confusion: a browser-only bot that still got a computer, an Auto
// task that hopped surfaces between turns, a plea that named no place.
import { describe, expect, it } from "vitest";

import {
  parseSurface,
  resolveSurface,
  surfaceForTool,
  surfaceOfComputerKind,
  surfacePrompt,
} from "./surface.ts";

describe("resolveSurface", () => {
  it("browser destination mounts only the built-in browser", () => {
    expect(resolveSurface({ destination: "browser", browserOn: true })).toEqual({
      computer: "off",
      browser: true,
      pinned: null,
      clearPin: false,
      note: "",
    });
  });

  it("browser destination with the browser switched off mounts nothing and says so", () => {
    const plan = resolveSurface({ destination: "browser", browserOn: false });
    expect(plan.computer).toBe("off");
    expect(plan.browser).toBe(false);
    expect(plan.note).toMatch(/switched off in App Settings/);
    expect(plan.note).toMatch(/no browser and no computer/);
  });

  it("a computer destination keeps the browser alongside it", () => {
    for (const destination of ["cloud", "vm", "local", "worker"] as const) {
      expect(resolveSurface({ destination, browserOn: true })).toMatchObject({ computer: destination, browser: true, pinned: null });
      expect(resolveSurface({ destination, browserOn: false })).toMatchObject({ computer: destination, browser: false });
    }
    expect(resolveSurface({ destination: "off", browserOn: true })).toMatchObject({ computer: "off", browser: true });
  });

  it("an explicit destination ignores the task's pin", () => {
    expect(resolveSurface({ destination: "cloud", pinnedSurface: "browser", browserOn: true, available: { browser: true } }))
      .toMatchObject({ computer: "cloud", browser: true, pinned: null, clearPin: false });
  });

  it("Auto without a pin resolves the way it always did", () => {
    expect(resolveSurface({ destination: undefined, browserOn: true })).toEqual({
      computer: undefined,
      browser: true,
      pinned: null,
      clearPin: false,
      note: "",
    });
  });

  it("Auto follows a pinned computer and mounts only that one", () => {
    for (const pin of ["cloud", "vm", "local", "worker"] as const) {
      expect(resolveSurface({ destination: undefined, pinnedSurface: pin, browserOn: true, available: { [pin]: true } }))
        .toEqual({ computer: pin, browser: false, pinned: pin, clearPin: false, note: "" });
    }
  });

  it("Auto follows a pinned browser and mounts no computer", () => {
    expect(resolveSurface({ destination: undefined, pinnedSurface: "browser", browserOn: true }))
      .toEqual({ computer: "off", browser: true, pinned: "browser", clearPin: false, note: "" });
  });

  it("Auto with a pin that is no longer reachable falls back and asks to clear it", () => {
    expect(resolveSurface({ destination: undefined, pinnedSurface: "cloud", browserOn: true, available: { cloud: false } }))
      .toEqual({ computer: undefined, browser: true, pinned: null, clearPin: true, note: "" });
    // absent availability is "not reachable", never "assume yes"
    expect(resolveSurface({ destination: undefined, pinnedSurface: "vm", browserOn: false })).toMatchObject({ clearPin: true, computer: undefined });
    expect(resolveSurface({ destination: undefined, pinnedSurface: "browser", browserOn: false })).toMatchObject({ clearPin: true, browser: false });
  });
});

describe("surfacePrompt", () => {
  it("names both surfaces and splits the work when both are mounted", () => {
    const text = surfacePrompt({ computer: "cloud", browser: true });
    expect(text).toMatch(/Two surfaces are mounted/);
    expect(text).toMatch(/Web tasks → the built-in browser/);
    expect(text).toMatch(/Desktop apps, files and shell → the cloud computer tools/);
    expect(text).toMatch(/Pick one surface for a task and stay on it/);
    expect(text).toMatch(/say which surface — the Browser tab or the cloud computer/);
  });

  it("names only the computer when it is the only surface", () => {
    const text = surfacePrompt({ computer: "vm", browser: false });
    expect(text).toMatch(/happens on the Local VM, web pages included/);
    expect(text).toMatch(/no separate built-in browser/);
    expect(text).not.toMatch(/Two surfaces/);
    expect(surfacePrompt({ computer: "local", browser: false })).toMatch(/tell them it is on this computer/);
  });

  it("names only the browser tab when it is the only surface", () => {
    const text = surfacePrompt({ computer: null, browser: true });
    expect(text).toMatch(/happens in the built-in browser tab/);
    expect(text).toMatch(/no desktop, file or shell computer/);
    expect(text).toMatch(/Browser tab of the Computer panel/);
    expect(text).not.toMatch(/cloud computer/);
  });

  it("is silent with nothing mounted, and carries the pin line and the note", () => {
    expect(surfacePrompt({ computer: null, browser: false })).toBe("");
    expect(surfacePrompt({ computer: "cloud", browser: false }, { pinned: "cloud" }))
      .toMatch(/This task has been running on the cloud computer; keep using it unless the user says otherwise\./);
    expect(surfacePrompt({ computer: null, browser: false }, { note: " NOTE." })).toBe(" NOTE.");
  });
});

describe("surfaceForTool", () => {
  it("trusts the Claude driver's server namespace", () => {
    expect(surfaceForTool("mcp__browser__browser_snapshot", { computer: "cloud", browser: true })).toBe("browser");
    expect(surfaceForTool("mcp__computer__browser_snapshot", { computer: "cloud", browser: true })).toBe("cloud");
    expect(surfaceForTool("mcp__computer__screenshot", { computer: "local", browser: false })).toBe("local");
    // a namespaced call for something this turn never mounted is noise
    expect(surfaceForTool("mcp__browser__browser_click", { computer: "cloud", browser: false })).toBeNull();
  });

  it("only trusts a bare name when one surface was mounted", () => {
    expect(surfaceForTool("browser_snapshot", { computer: "cloud", browser: true })).toBeNull();
    expect(surfaceForTool("screenshot", { computer: "vm", browser: false })).toBe("vm");
    expect(surfaceForTool("browser_navigate", { computer: null, browser: true })).toBe("browser");
    expect(surfaceForTool("Bash: ls", { computer: "vm", browser: false })).toBeNull();
    expect(surfaceForTool("Read", { computer: null, browser: true })).toBeNull();
  });
});

describe("surface parsing", () => {
  it("accepts only the five surfaces off the wire", () => {
    expect(parseSurface("browser")).toBe("browser");
    expect(parseSurface("cloud")).toBe("cloud");
    expect(parseSurface("worker")).toBe("worker");
    expect(parseSurface("box")).toBeUndefined();
    expect(parseSurface(42)).toBeUndefined();
    expect(parseSurface(undefined)).toBeUndefined();
  });

  it("folds both cloud backends into one surface", () => {
    expect(surfaceOfComputerKind("box")).toBe("cloud");
    expect(surfaceOfComputerKind("vps")).toBe("cloud");
    expect(surfaceOfComputerKind("vm")).toBe("vm");
    expect(surfaceOfComputerKind("local")).toBe("local");
    expect(surfaceOfComputerKind("worker")).toBe("worker");
    expect(surfaceOfComputerKind(null)).toBeNull();
  });
});
