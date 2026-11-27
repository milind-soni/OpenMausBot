import { describe, expect, it } from "vitest";

import { chosenPlace, pickComputer, type ComputerOption } from "./computer-selection.ts";

const option = (surface: ComputerOption["surface"], state: "ready" | "asleep" | "missing" | "off"): ComputerOption => ({
  surface,
  available: state !== "off",
  ready: state === "ready",
  canStart: state === "asleep",
  canCreate: state === "missing",
});

describe("which computer select_computer picks", () => {
  // A Works on: Cloud computer turn before its first computer call: the
  // cloud computer is missing or asleep, and the built-in browser is ready.
  const offered = (cloud: "asleep" | "missing") => [option("cloud", cloud), option("vm", "off"), option("browser", "ready")];

  it("keeps the cloud computer this turn starts on its first call: asking for it or for Auto never moves the request", () => {
    for (const cloud of ["asleep", "missing"] as const) {
      for (const requested of ["cloud", "auto"] as const) {
        const picked = pickComputer(offered(cloud), requested, "cloud", true);
        expect(picked.option?.surface).toBe("cloud");
        expect(picked.current).toBe(true);
      }
    }
  });

  it("switches away from a current computer that is not up and not this turn's to start", () => {
    // A failed start, or a desktop only leased once it is up.
    const auto = pickComputer(offered("asleep"), "auto", "cloud", false);
    expect(auto.option?.surface).toBe("browser");
    expect(auto.current).toBe(false);
    const cloud = pickComputer(offered("asleep"), "cloud", "cloud", false);
    expect(cloud.option?.surface).toBe("cloud");
    expect(cloud.current).toBe(false);
  });

  it("keeps a ready current computer, and moves to another when asked", () => {
    const options = [option("cloud", "ready"), option("browser", "ready")];
    expect(pickComputer(options, "auto", "cloud", false)).toMatchObject({ option: { surface: "cloud" }, current: true });
    expect(pickComputer(options, "browser", "cloud", true)).toMatchObject({ option: { surface: "browser" }, current: false });
  });

  it("on Auto with nothing current prefers a ready Local VM, then anything ready, then one it can start or create", () => {
    expect(pickComputer([option("browser", "ready"), option("vm", "ready")], "auto", "off", false).option?.surface).toBe("vm");
    expect(pickComputer([option("cloud", "asleep"), option("browser", "ready")], "auto", "off", false).option?.surface).toBe("browser");
    expect(pickComputer([option("cloud", "missing"), option("vm", "asleep")], "auto", "off", false).option?.surface).toBe("vm");
    expect(pickComputer([option("cloud", "missing"), option("vm", "missing")], "auto", "off", false).option?.surface).toBe("vm");
    expect(pickComputer([option("cloud", "off")], "auto", "off", false).option).toBeUndefined();
  });

  it("on Auto starts a stopped private desktop before waking or creating a cloud computer", () => {
    // A stopped or recreatable private desktop reads as canCreate; a sleeping cloud computer as canStart.
    expect(pickComputer([option("cloud", "asleep"), option("vm", "missing")], "auto", "off", false).option?.surface).toBe("vm");
    expect(pickComputer([option("cloud", "asleep"), option("vm", "off")], "auto", "off", false).option?.surface).toBe("cloud");
  });

  it("on Auto keeps the place the person chose while it can be had, even when another computer is up, and moves only when asked", () => {
    const options = [option("cloud", "ready"), option("vm", "missing"), option("browser", "ready")];
    expect(pickComputer(options, "auto", "off", false, "vm")).toMatchObject({ option: { surface: "vm" }, current: false });
    expect(pickComputer([option("cloud", "asleep"), option("vm", "ready")], "auto", "off", false, "cloud").option?.surface).toBe("cloud");
    expect(pickComputer(options, "cloud", "off", false, "vm").option?.surface).toBe("cloud");
    // A chosen place that cannot be had at all leaves Auto its usual pick.
    expect(pickComputer([option("cloud", "missing"), option("browser", "off")], "auto", "off", false, "browser").option?.surface).toBe("cloud");
    expect(pickComputer(options, "auto", "vm", true, "vm")).toMatchObject({ option: { surface: "vm" }, current: true });
  });
});

describe("the place a person chose", () => {
  it("is their pin in the conversation, else the bot's Works on, and never a pin a turn made or Auto/Off", () => {
    expect(chosenPlace({ surface: "vm", surfaceSource: "user" }, "cloud")).toBe("vm");
    expect(chosenPlace({ surface: "vm" }, undefined)).toBe("vm");
    expect(chosenPlace({ surface: "cloud", surfaceSource: "auto" }, "vm")).toBe("vm");
    expect(chosenPlace({ surface: "cloud", surfaceSource: "auto" }, undefined)).toBeUndefined();
    expect(chosenPlace(undefined, "off")).toBeUndefined();
    expect(chosenPlace(undefined, "browser")).toBe("browser");
  });
});
