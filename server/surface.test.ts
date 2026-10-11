// Where a turn's hands land. The policy is small but every branch was a
// real confusion: a browser-only bot that still got a computer, an Auto
// task that hopped surfaces between turns, a plea that named no place.
import { describe, expect, it } from "vitest";

import {
  browserIsThePlace,
  cloudPlaceRefusal,
  computerSkippedNote,
  computerToolsRefusal,
  parseSurface,
  placeUnavailable,
  resolveSurface,
  surfaceOfComputerKind,
  surfacePrompt,
} from "./surface.ts";

describe("browserIsThePlace", () => {
  it("is true only where the conversation works on the built-in browser", () => {
    expect(browserIsThePlace(resolveSurface({ destination: "browser", browserOn: true }))).toBe(true);
    // An Auto conversation whose first turn landed on the browser.
    expect(browserIsThePlace(resolveSurface({ destination: undefined, pinnedSurface: "browser", browserOn: true }))).toBe(true);
    // Auto only falls back to the browser when no computer is reached.
    expect(browserIsThePlace(resolveSurface({ destination: undefined, browserOn: true }))).toBe(false);
    expect(browserIsThePlace(resolveSurface({ destination: "browser", browserOn: false }))).toBe(false);
    expect(browserIsThePlace(resolveSurface({ destination: "local", browserOn: true }))).toBe(false);
    expect(browserIsThePlace(resolveSurface({ destination: "off", browserOn: true }))).toBe(false);
  });
});

describe("resolveSurface", () => {
  it("browser destination mounts only the built-in browser", () => {
    expect(resolveSurface({ destination: "browser", browserOn: true })).toEqual({
      computer: "off",
      browser: true,
      pinned: null,
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

  it("a computer destination mounts only that computer: one place per turn", () => {
    for (const destination of ["cloud", "vm", "local"] as const) {
      // the bot's browser switch no longer adds a second place next to a computer
      expect(resolveSurface({ destination, browserOn: true })).toEqual({ computer: destination, browser: false, pinned: null, note: "" });
      expect(resolveSurface({ destination, browserOn: false })).toMatchObject({ computer: destination, browser: false });
    }
  });

  it("Off mounts no computer and no browser, and says which setting did it", () => {
    const plan = resolveSurface({ destination: "off", browserOn: true });
    expect(plan).toMatchObject({ computer: "off", browser: false, pinned: null });
    expect(plan.note).toMatch(/"Works on" setting is Off/);
    expect(plan.note).toMatch(/no computer and no built-in browser/);
    // the same whether or not a browser could have been mounted
    expect(resolveSurface({ destination: "off", browserOn: false })).toEqual(plan);
    // nothing mounted, so the surface paragraph stays silent and only the
    // note tells the model why it has no screen
    expect(surfacePrompt({ computer: null, browser: false }, { note: plan.note })).toBe(plan.note);
  });

  it("a Team incidents turn that lost its computer is told why and that it has none", () => {
    const note = computerSkippedNote("The team's cloud computer is missing; explicitly create or retry it from the Team map.");
    expect(note).toMatch(/^ This turn answers a Team incidents report and your computer could not be prepared for it \(The team's cloud computer is missing; explicitly create or retry it from the Team map\), so no computer is mounted/);
    expect(note).toMatch(/never claim to have checked that computer yourself\.$/);
    // nothing mounted: the note alone is the surface paragraph
    expect(surfacePrompt({ computer: null, browser: false }, { note })).toBe(note);
    // a browser the plan allowed still mounts beside it, and is described
    const withBrowser = surfacePrompt({ computer: null, browser: true }, { note });
    expect(withBrowser).toMatch(/^ Everything you do on screen happens in the built-in browser tab/);
    expect(withBrowser.endsWith(note)).toBe(true);
  });

  it("Off is the one setting a conversation pin cannot override", () => {
    expect(resolveSurface({ destination: "off", pinnedSurface: "browser", browserOn: true }))
      .toMatchObject({ computer: "off", browser: false, pinned: null });
    expect(resolveSurface({ destination: "off", pinnedSurface: "cloud", browserOn: true }))
      .toMatchObject({ computer: "off", browser: false, pinned: null });
  });

  it("a conversation pin wins over the bot's default, whatever that default is", () => {
    // pinned to the browser from the composer while the bot defaults to a computer
    expect(resolveSurface({ destination: "cloud", pinnedSurface: "browser", browserOn: true }))
      .toEqual({ computer: "off", browser: true, pinned: "browser", note: "" });
    // pinned to a computer while the bot is browser-only or on Auto
    for (const destination of ["browser", undefined] as const) {
      for (const pin of ["cloud", "vm", "local"] as const) {
        expect(resolveSurface({ destination, pinnedSurface: pin, browserOn: true }))
          .toEqual({ computer: pin, browser: false, pinned: pin, note: "" });
      }
    }
  });

  it("keeps an unavailable browser pin instead of silently moving to another computer", () => {
    for (const destination of [undefined, "local", "vm", "cloud", "browser"] as const) {
      expect(resolveSurface({ destination, pinnedSurface: "browser", browserOn: false }))
        .toMatchObject({ computer: "off", browser: false, pinned: "browser",
          note: expect.stringMatching(/No computer is mounted instead/) });
    }
  });

  it("Auto without a pin leaves the computer to the dispatch and keeps the browser as its fallback", () => {
    expect(resolveSurface({ destination: undefined, browserOn: true })).toEqual({
      computer: undefined,
      browser: true,
      pinned: null,
      note: "",
    });
    expect(resolveSurface({ destination: undefined, browserOn: false })).toMatchObject({ computer: undefined, browser: false });
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
    expect(text).toMatch(/say in one short sentence where you are working/);
    expect(text).not.toMatch(/Two surfaces/);
    expect(surfacePrompt({ computer: "local", browser: false })).toMatch(/tell them it is on this computer/);
  });

  it("names only the browser tab when it is the only surface", () => {
    const text = surfacePrompt({ computer: null, browser: true });
    expect(text).toMatch(/happens in the built-in browser tab/);
    expect(text).toMatch(/no desktop, file or shell computer/);
    expect(text).toMatch(/Browser tab of the Computer panel/);
    expect(text).toMatch(/say in one short sentence where you are working/);
    expect(text).not.toMatch(/happens on the cloud computer/);
  });

  it("explains unavailable tools, and carries the pin line and the note", () => {
    expect(surfacePrompt({ computer: null, browser: false })).toContain("No computer or built-in browser tools are mounted");
    expect(surfacePrompt({ computer: "cloud", browser: false }, { pinned: "cloud" }))
      .toContain("This conversation is pinned to the cloud computer; changing places requires");
    expect(surfacePrompt({ computer: null, browser: false }, { note: " NOTE." })).toBe(" NOTE.");
  });

  it.each(["local", "vm", "cloud", "browser"] as const)("requires observed results on the actual %s tools", (place) => {
    const text = surfacePrompt({ computer: place === "browser" ? null : place, browser: place === "browser" });
    expect(text).toContain("verify its result before claiming success");
    expect(text).toContain("Announcing an action is not performing it");
    expect(text).toContain("never act on a different computer or describe a host window as a VM");
    expect(text).toContain("use OpenMausBot's mounted browser/computer tools first");
    expect(text).toContain("Do not substitute the provider's own desktop");
  });

  it("chooses and starts configured targets through chat instead of requiring menu nudges", () => {
    const text = surfacePrompt({ computer: null, browser: false }, { canSelect: true });
    expect(text).toContain("use select_computer with no arguments");
    expect(text).toContain("surface auto instead of asking them to operate the menu");
    expect(text).toContain("highlight the selected target");
    expect(text).toContain("when it needs desktop apps or capabilities the current Browser lacks, select an available Local VM");
    expect(text).toContain("then you must carry out the task");
    expect(text).not.toContain("ask the user to choose and connect a computer");
  });

  it("keeps explicit destinations and uses a turn-bound switch when supported", () => {
    const text = surfacePrompt({ computer: "local", browser: false }, { pinned: "local", canSelect: true });
    expect(text).toContain("select the requested available place");
    expect(text).toContain("changing places requires select_computer");
    expect(text).toContain("Never silently replace an explicitly requested VM with the host desktop");
    expect(text).not.toContain("ask the user to change where this conversation works");
  });

  it("sends the person to the Computer panel, the place control both interface modes show", () => {
    const text = surfacePrompt({ computer: "cloud", browser: false }, { pinned: "cloud" });
    expect(text).toContain("explain the mismatch and ask the user to change where this conversation works in the Computer panel");
    expect(text).toContain("changing places requires the user's choice in the Computer panel, not a different tool name");
    // Simple mode has no composer chip, so no selector the person cannot see.
    expect(text).not.toContain("computer selector");
  });

  // Every shape of the paragraph a turn can get: each mount, pinned or not,
  // with and without select_computer.
  const mounts: Array<{ computer: "cloud" | null; browser: boolean }> = [
    { computer: "cloud", browser: false }, { computer: null, browser: true }, { computer: "cloud", browser: true }, { computer: null, browser: false },
  ];
  const shapes = mounts.flatMap((mounted) => ([{}, { canSelect: true }, { canSelect: true, pinned: "cloud" }] as Array<{ canSelect?: boolean; pinned?: "cloud" }>)
    .map((opts) => ({ mounted, opts })));

  it("tells a Cloud home's bots only about the places it has", () => {
    for (const { mounted, opts } of shapes) {
      const text = surfacePrompt(mounted, { ...opts, cloudHome: true });
      expect(text, JSON.stringify({ mounted, opts })).not.toMatch(/Local VM|\bVM\b|host desktop|user's host|host window/);
      if (mounted.computer || mounted.browser) {
        expect(text).toContain("the cloud computer is remote, the built-in browser is a separate browser, and the user's own computer cannot be reached from here");
        expect(text).toContain("never act on a different computer.");
      }
      if (opts.canSelect) expect(text).toContain("select an available cloud computer without asking");
    }
  });

  it("leaves every other server's paragraph exactly as it was", () => {
    for (const { mounted, opts } of shapes) {
      expect(surfacePrompt(mounted, { ...opts, cloudHome: false })).toBe(surfacePrompt(mounted, opts));
    }
    expect(surfacePrompt({ computer: "cloud", browser: true }, { canSelect: true }))
      .toContain("this computer is the user's host, Local VM is an isolated desktop, the cloud computer is remote");
  });
});

describe("surface parsing", () => {
  it("accepts only the four surfaces off the wire", () => {
    expect(parseSurface("browser")).toBe("browser");
    expect(parseSurface("cloud")).toBe("cloud");
    expect(parseSurface("box")).toBeUndefined();
    expect(parseSurface(42)).toBeUndefined();
    expect(parseSurface(undefined)).toBeUndefined();
  });

  it("folds both cloud backends into one surface", () => {
    expect(surfaceOfComputerKind("box")).toBe("cloud");
    expect(surfaceOfComputerKind("vps")).toBe("cloud");
    expect(surfaceOfComputerKind("vm")).toBe("vm");
    expect(surfaceOfComputerKind("local")).toBe("local");
    expect(surfaceOfComputerKind(null)).toBeNull();
  });
});


it("does not instruct use of a selected browser when no surface is mounted", () => {
  expect(surfacePrompt({ computer: null, browser: false }, { canSelect: true })).not.toContain("For online research");
  expect(surfacePrompt({ computer: null, browser: true })).toContain("For online research");
});

describe("cloudPlaceRefusal", () => {
  const engine = (patch: { computerMcp?: boolean }) => ({ name: "Llama", ...patch });

  it("lets every engine with computer tools use the cloud computer, whatever it runs on", () => {
    expect(cloudPlaceRefusal(engine({ computerMcp: true }), "works-on", "Scout")).toBeNull();
    expect(cloudPlaceRefusal(engine({ computerMcp: true }), "routine", "Scout")).toBeNull();
  });

  it("refuses an engine without computer tools as one state, its fix the same whatever the source", () => {
    const refused = cloudPlaceRefusal(engine({ computerMcp: false }), "works-on", "Scout")!;
    expect(refused).toMatchObject({ name: "PlaceUnavailableError", place: "cloud", row: { state: "cc-cannot", params: { bot: "Scout", model: "Llama" }, source: "works-on" } });
    expect(refused.message).toBe("Llama can't use a computer. Choose a model that can, such as Claude or ChatGPT. Choose another model in Scout's settings.");
    for (const source of ["pin", "routine", "room"] as const) {
      expect(cloudPlaceRefusal(engine({}), source, "Scout")?.message).toBe(refused.message);
    }
  });
});

describe("computerToolsRefusal", () => {
  it("refuses a Tool selection without the computer with one action: the setting that changes it", () => {
    const refused = computerToolsRefusal({ deny: ["mcp:computer:*"] }, "works-on", "Scout")!;
    expect(refused).toMatchObject({ name: "PlaceUnavailableError", place: "cloud", row: { state: "cc-tools-off", params: { bot: "Scout" }, source: "works-on" } });
    const line = "What Scout can use doesn't include a computer. Change what Scout can use in its settings.";
    expect(refused.message).toBe(line);
    // The same one action whatever chose the place: never a second one, and
    // never "Set Works on to Auto".
    for (const source of ["pin", "routine", "room"] as const) {
      expect(computerToolsRefusal({ allow: ["native:*"] }, source, "Scout")?.message).toBe(line);
    }
    // An Auto-recorded pin is cleared by the dispatch, and the line says so.
    expect(computerToolsRefusal({ allow: ["native:*"] }, "auto-pin", "Scout")?.message)
      .toBe("What Scout can use doesn't include a computer. This conversation is back on Auto. Change what Scout can use in its settings.");
  });

  it("lets every selection that keeps a computer tool through", () => {
    expect(computerToolsRefusal(undefined, "works-on", "Scout")).toBeNull();
    expect(computerToolsRefusal({ allow: ["native:*", "mcp:computer:screenshot"] }, "works-on", "Scout")).toBeNull();
    expect(computerToolsRefusal({ deny: ["mcp:computer:exec"] }, "works-on", "Scout")).toBeNull();
  });
});

describe("placeUnavailable", () => {
  it("words a passing cause's way on by where the place came from, and never says Set Works on to Auto", () => {
    const cause = (source: "works-on" | "pin" | "auto-pin" | "routine" | "room") =>
      placeUnavailable("cloud", { state: "cc-no-start", params: { bot: "Scout" }, source }).message;
    expect(cause("works-on")).toBe("Scout's cloud computer didn't start. Try again.");
    expect(cause("pin")).toBe("Scout's cloud computer didn't start. Clear this conversation's place in the composer to continue.");
    expect(cause("auto-pin")).toBe("Scout's cloud computer didn't start. This conversation is back on Auto. Send your message again.");
    expect(cause("routine")).toBe("Scout's cloud computer didn't start. Change where this routine runs.");
    expect(cause("room")).toBe("Scout's cloud computer didn't start.");
    expect(placeUnavailable("vm", { state: "place-failed", params: { bot: "Scout", cause: "The Local VM is not ready." }, source: "works-on" }))
      .toMatchObject({ name: "PlaceUnavailableError", place: "vm", message: "The Local VM is not ready. Check it in the Computer panel." });
  });

  it("keeps the whole cause: no row cuts it", () => {
    const long = `${"x".repeat(400)}.`;
    expect(placeUnavailable("vm", { state: "place-failed", params: { bot: "Scout", cause: long }, source: "works-on" }).message)
      .toBe(`${long} Check it in the Computer panel.`);
  });
});
