import { describe, expect, it } from "vitest";

import {
  addressesEveryone,
  applyHoldDirective,
  classifyHoldDirective,
  isStopCommand,
  MAX_HELD_MESSAGES,
  rememberHeldMessage,
  stopWordPlacement,
} from "./room-holds.ts";

const members = ["scout", "pixel", "bee"];

describe("room member holds", () => {
  it("holds a member when a stop word sits next to its mention", () => {
    expect(classifyHoldDirective("stop @Scout", ["scout"])).toEqual({ hold: ["scout"], holdAll: false, release: [], releaseAll: false });
    expect(classifyHoldDirective("@Scout please halt", ["scout"]).hold).toEqual(["scout"]);
    expect(classifyHoldDirective("pause @New Bot", ["newbot"]).hold).toEqual(["newbot"]);
    expect(classifyHoldDirective("STOP @Scout and @Pixel", ["scout", "pixel"]).hold).toEqual(["scout", "pixel"]);
  });

  it("reads a stop word with an object as a task, not a hold", () => {
    expect(classifyHoldDirective("@Engineer stop this bridge and uninstall it", ["engineer"])).toEqual({ hold: [], holdAll: false, release: ["engineer"], releaseAll: false });
    expect(classifyHoldDirective("@Scout pause the render at 10s", ["scout"]).hold).toEqual([]);
    expect(classifyHoldDirective("@Scout stop that", ["scout"]).hold).toEqual(["scout"]);
    expect(classifyHoldDirective("@Scout stop it now", ["scout"]).hold).toEqual(["scout"]);
    expect(classifyHoldDirective("stop the @Scout", ["scout"]).hold).toEqual(["scout"]);
    expect(classifyHoldDirective("@Scout stop that now", ["scout"]).hold).toEqual(["scout"]);
    expect(classifyHoldDirective("@Scout stop this right now", ["scout"]).hold).toEqual(["scout"]);
    expect(classifyHoldDirective("@Scout pause your work", ["scout"]).hold).toEqual(["scout"]);
  });

  it("releases a member addressed directly without a stop word", () => {
    expect(classifyHoldDirective("@Scout resume", ["scout"])).toEqual({ hold: [], holdAll: false, release: ["scout"], releaseAll: false });
    expect(classifyHoldDirective("@Scout what did you find?", ["scout"]).release).toEqual(["scout"]);
  });

  it("treats a stop word far from every mention as neither a hold nor a release", () => {
    expect(stopWordPlacement("@Scout go, das ist halt ein Test")).toBe("distant");
    expect(classifyHoldDirective("@Scout go, das ist halt ein Test", ["scout"])).toEqual({ hold: [], holdAll: false, release: [], releaseAll: false });
  });

  it("ignores stop words the person quotes or pastes", () => {
    expect(stopWordPlacement("@Scout what does `stop` do?")).toBeNull();
    expect(stopWordPlacement('@Scout the log said "stop"')).toBeNull();
    expect(stopWordPlacement("@Scout look:\n```\nstop\n```")).toBeNull();
    expect(stopWordPlacement("> stop @Scout\nwhat did they mean?")).toBeNull();
    expect(classifyHoldDirective("> stop @Scout\nwhat did they mean?", ["scout"]).release).toEqual(["scout"]);
  });

  it("holds and resumes everyone through @everyone / @all", () => {
    expect(addressesEveryone("@all stop")).toBe(true);
    expect(addressesEveryone("@everyone resume")).toBe(true);
    expect(addressesEveryone("@allison hi")).toBe(false);
    expect(addressesEveryone("mail me@all.example")).toBe(false);
    expect(classifyHoldDirective("@all stop", []).holdAll).toBe(true);
    expect(classifyHoldDirective("@everyone resume", []).releaseAll).toBe(true);
    expect(classifyHoldDirective("resume", []).releaseAll).toBe(true);
    expect(classifyHoldDirective("Resume all.", []).releaseAll).toBe(true);
    expect(classifyHoldDirective("resume the deploy tomorrow", []).releaseAll).toBe(false);
  });

  it("applies directives to the room's holds and reports what changed", () => {
    const first = applyHoldDirective(undefined, classifyHoldDirective("stop @Scout", ["scout"]), members, 10);
    expect(first).toEqual({ holds: { scout: { at: 10 } }, held: ["scout"], released: [] });
    const again = applyHoldDirective(first.holds, classifyHoldDirective("stop @Scout", ["scout"]), members, 20);
    expect(again.holds).toBe(first.holds);
    expect(again.held).toEqual([]);
    const all = applyHoldDirective(first.holds, classifyHoldDirective("@all stop", []), members, 30);
    expect(all.holds).toEqual({ scout: { at: 10 }, pixel: { at: 30 }, bee: { at: 30 } });
    expect(all.held).toEqual(["pixel", "bee"]);
    const one = applyHoldDirective(all.holds, classifyHoldDirective("@Pixel carry on", ["pixel"]), members, 40);
    expect(Object.keys(one.holds)).toEqual(["scout", "bee"]);
    expect(one.released).toEqual(["pixel"]);
    const none = applyHoldDirective(one.holds, classifyHoldDirective("@all resume", []), members, 50);
    expect(none.holds).toEqual({});
    expect(none.released).toEqual(["scout", "bee"]);
  });

  it("only holds room members", () => {
    expect(applyHoldDirective({}, { hold: ["stranger"], holdAll: false, release: [], releaseAll: false }, members, 1).held).toEqual([]);
  });

  it("keeps a bounded, de-duplicated list of messages for a held member", () => {
    let held = rememberHeldMessage(undefined, "scout", { threadId: "t", messageId: "m1" });
    held = rememberHeldMessage(held, "scout", { threadId: "t", messageId: "m1" });
    expect(held.scout).toHaveLength(1);
    for (let i = 0; i < MAX_HELD_MESSAGES + 5; i += 1) held = rememberHeldMessage(held, "scout", { threadId: "t", messageId: `x${i}` });
    expect(held.scout).toHaveLength(MAX_HELD_MESSAGES);
    expect(held.scout.at(-1)?.messageId).toBe(`x${MAX_HELD_MESSAGES + 4}`);
  });
});

describe("isStopCommand", () => {
  it("reads a message made only of stop words and fillers as a stop", () => {
    for (const text of ["stop", "Stop now!", "please stop", "STOP STOP", "cancel that", "abort", "halt it", "stop everything"]) {
      expect(isStopCommand(text), text).toBe(true);
    }
  });

  it("reads any other message as a message, including a quoted or coded stop", () => {
    for (const text of ["", "all right", "stop using tabs", "don't stop", "pause", "stop the build and run tests", "`stop`", "\"stop\"", "> stop"]) {
      expect(isStopCommand(text), text).toBe(false);
    }
  });
});
