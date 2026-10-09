import { describe, expect, it } from "vitest";

import en from "../src/locales/en.json";
import {
  cloudRefusal, PLACE_EN, PLACE_STATES, PLACE_WORDS, placeRowText, placeRowView, placeState, placeView, placeViewOf,
  type PlaceFacts, type PlaceParams, type PlaceSource, type PlaceState,
} from "./place-view.ts";

/** Every param any line or action names, so a state always reads whole. */
const PARAMS: PlaceParams = {
  bot: "Scout", engine: "Claude", model: "Llama", computer: "Team desk", hours: 50, month: "November",
  plan: "Pro", max: 2, holders: ["Ada", "Bo"], words: "Start the Boat plan to create sandboxes.", reason: "CUA Driver is not ready.",
  cause: "the Local VM is not ready",
};

const facts = (patch: Partial<PlaceFacts> = {}): PlaceFacts => ({
  place: "cloud", server: "my-cloud", bot: "Scout", boat: "included", role: "admin", toolsAllowComputer: true, browserOn: true,
  engine: { name: "Claude", model: "Claude Fable 5", computer: true, browser: true, signedIn: true },
  ...patch,
});

describe("U1: one line and at most one action for every state", () => {
  it("words every state whole, for an Admin and for a User", () => {
    for (const state of PLACE_STATES) {
      for (const role of ["admin", "user"] as const) {
        const view = placeViewOf(state, PARAMS, { role, server: "my-cloud" });
        expect(view.short.trim(), state).not.toBe("");
        expect(view.line.trim(), state).not.toBe("");
        // one message: no second paragraph, no placeholder left unfilled
        expect(view.line, state).not.toMatch(/\n|\{\w+\}/);
        expect(view.short, state).not.toMatch(/\{\w+\}/);
        if (view.action) expect(view.action.label, state).not.toMatch(/^$|\{\w+\}/);
      }
    }
  });

  it("gives a User no action that changes a setting, and says who can", () => {
    for (const state of PLACE_STATES) {
      const admin = placeViewOf(state, PARAMS, { role: "admin", server: "my-cloud" });
      const user = placeViewOf(state, PARAMS, { role: "user", server: "my-cloud" });
      if (!admin.action || admin.action.id === "try-again" || admin.action.id === "watch" || admin.action.id === "clear-pin" || admin.action.id === "open-computer-panel") {
        expect(user, state).toEqual(admin);
        continue;
      }
      // Starting a computer early is a shortcut: a User's own message starts it.
      if (admin.action.id === "start" || admin.action.id === "wake") {
        expect(user, state).toEqual({ ...admin, action: null });
        continue;
      }
      expect(user.action, state).toBeNull();
      expect(user.line, state).toBe(`${admin.line} Ask an Admin to change it.`);
    }
  });

  it("mirrors en.json exactly, key for key", () => {
    const catalog = en as Record<string, string>;
    for (const [key, value] of Object.entries(PLACE_EN)) expect(catalog[key], key).toBe(value);
    const mirrored = new Set(Object.keys(PLACE_EN));
    const inCatalog = Object.keys(catalog).filter((key) => /^place\.(view|action)\./.test(key) || key === "place.askAdmin" || key === "place.backOnAuto");
    expect(inCatalog.filter((key) => !mirrored.has(key))).toEqual([]);
  });

  it("keeps jargon out of what subscribers read", () => {
    const boatAllowed = new Set<PlaceState>(["cc-needs-key", "cc-provider"]);
    for (const state of PLACE_STATES) {
      const view = placeViewOf(state, { ...PARAMS, words: "x" }, { role: "admin", server: "my-cloud" });
      const words = `${view.short} ${view.line} ${view.action?.label ?? ""}`;
      if (!boatAllowed.has(state)) expect(words, state).not.toMatch(/Boat/);
      expect(words, state).not.toMatch(/\bbox\b|OMB|Hosted desktop|Cloud box|Works on to Auto|\btools?\b/i);
      if (state.startsWith("cc-")) expect(words, state).not.toMatch(/\bVM\b/);
    }
    for (const [id, sentence] of Object.entries(PLACE_WORDS)) {
      expect(sentence, id).not.toMatch(/\bbox\b|OMB|Hosted desktop|Cloud box|Works on to Auto|\btools?\b/i);
      if (id !== "add-boat-key") expect(sentence, id).not.toMatch(/Boat/);
    }
  });

  it("uses the plan's state table copy", () => {
    const admin = { role: "admin" as const, server: "my-cloud" as const };
    expect(placeViewOf("cc-no-hours", { hours: 50, month: "November" }, admin)).toMatchObject({
      short: "No hours left", line: "This month's 50 cloud computer hours are used up. They come back on 1 November.",
      action: { id: "see-plan", label: "See your plan" },
    });
    expect(placeViewOf("cc-at-once", { plan: "Personal", max: 1, holders: ["Ada"] }, admin).line)
      .toBe("Your Personal plan includes 1 cloud computer, and Ada has it.");
    expect(placeViewOf("cc-at-once", { plan: "Pro", max: 2, holders: ["Ada", "Bo"] }, admin).line)
      .toBe("Your Pro plan includes 2 cloud computers, and Ada and Bo have them.");
    // A refusal known only by its code still reads whole.
    expect(placeViewOf("cc-at-once", { plan: "Pro", max: 2 }, admin).line).toBe("All the cloud computers your plan includes are in use.");
    expect(placeViewOf("cc-no-hours", {}, admin).line).toBe("This month's cloud computer hours are used up.");
    expect(placeViewOf("cc-unavailable", {}, admin)).toMatchObject({
      short: "Not available now", line: "Cloud computers can't start right now. It isn't anything you did.", action: { id: "try-again" },
    });
    expect(placeViewOf("cc-on-my-cloud", {}, { role: "admin", server: "mac" })).toMatchObject({
      line: "Cloud computers from your plan work for bots on My Cloud for now.", action: { id: "open-my-cloud", label: "Open My Cloud" },
    });
    expect(placeViewOf("auto", {}, { role: "admin", server: "mac" }).line)
      .toBe("Uses the built-in browser, a private desktop on this computer, or this computer's screen, whichever the task needs.");
    expect(placeViewOf("cc-provider", { bot: "Scout", words: "Start the $20/month Boat plan." }, admin))
      .toMatchObject({ short: "Couldn't start", line: "Your Boat account couldn't start Scout's cloud computer: Start the $20/month Boat plan." });
  });
});

describe("placeState", () => {
  it("reads the cloud computer's facts in order: model, what it can use, sign-in, provider, state", () => {
    expect(placeState(facts({ engine: { name: "Llama", computer: false, browser: true, signedIn: true } })).state).toBe("cc-cannot");
    expect(placeState(facts({ toolsAllowComputer: false })).state).toBe("cc-tools-off");
    expect(placeState(facts({ engine: { name: "Claude", computer: true, browser: true, signedIn: false } }))).toEqual({
      state: "cc-sign-in", params: { bot: "Scout", engine: "Claude" },
    });
    expect(placeState(facts({ server: "mac", boat: "none", plan: true })).state).toBe("cc-on-my-cloud");
    expect(placeState(facts({ server: "pc", boat: "none" })).state).toBe("cc-needs-key");
    expect(placeState(facts({ server: "mac", boat: "own-key" })).state).toBe("cc-new");
    expect(placeState(facts({ computer: "starting" })).state).toBe("cc-starting");
    expect(placeState(facts({ computer: "asleep" })).state).toBe("cc-asleep");
    expect(placeState(facts({ computer: "on" })).state).toBe("cc-on");
    expect(placeState(facts({ refusal: { state: "cc-no-hours", params: { hours: 50, month: "November" } } }))).toEqual({
      state: "cc-no-hours", params: { bot: "Scout", hours: 50, month: "November" },
    });
    expect(placeState(facts({ backend: "vps" })).state).toBe("vps");
  });

  it("reads Auto, Off, the browser, this computer and a Local VM", () => {
    expect(placeState(facts({ place: "auto" })).state).toBe("auto");
    expect(placeState(facts({ place: "auto", teamComputer: "Team desk" }))).toEqual({ state: "auto-team", params: { bot: "Scout", computer: "Team desk" } });
    expect(placeState(facts({ place: "off" })).state).toBe("off");
    expect(placeState(facts({ place: "browser" })).state).toBe("browser");
    expect(placeState(facts({ place: "browser", browserOn: false })).state).toBe("browser-off");
    expect(placeState(facts({ place: "browser", engine: { name: "X", computer: true, browser: false, signedIn: true } })).state).toBe("browser-cannot");
    expect(placeState(facts({ place: "local", local: { ready: false, reason: "Not yet." } }))).toEqual({
      state: "local-unavailable", params: { bot: "Scout", reason: "Not yet." },
    });
    expect(placeState(facts({ place: "vm", engine: { name: "X", computer: false, browser: true, signedIn: true } })).state).toBe("vm-cannot");
  });

  it("words the Auto line for where this server runs", () => {
    expect(placeView(facts({ place: "auto" })).line).toMatch(/starts its cloud computer by itself/);
    expect(placeView(facts({ place: "auto", server: "pc" })).line).not.toMatch(/Local VM/);
    expect(placeView(facts({ place: "auto", server: "linux" })).line).toMatch(/Local VM/);
    expect(placeView(facts({ engine: { name: "Claude", computer: true, browser: true, signedIn: false } })).line)
      .toBe("Sign in to Claude on My Cloud first. Scout uses it on the cloud computer too.");
  });
});

describe("a failed place, by where it came from", () => {
  const row = (source: PlaceSource, state: PlaceState = "cc-unavailable") => ({ state, params: { bot: "Scout" }, source });

  it("has its own way on per source for a passing cause", () => {
    const view = (source: PlaceSource, mode?: "simple" | "advanced") =>
      placeRowView(row(source), { role: "admin", mode, worksOnLabel: "Auto" });
    expect(view("works-on").action).toEqual({ id: "try-again", label: "Try again" });
    expect(view("pin", "advanced").action).toEqual({ id: "clear-pin", label: "Clear this conversation's place" });
    expect(view("pin", "simple").action).toEqual({ id: "clear-pin", label: "Use Auto" });
    expect(view("auto-pin")).toMatchObject({ line: "Cloud computers can't start right now. It isn't anything you did. This conversation is back on Auto.", action: { id: "try-again" } });
    expect(view("routine").action).toEqual({ id: "change-routine", label: "Change where it runs" });
    expect(view("room").action).toBeNull();
  });

  it("keeps a cause's own fix whatever the source", () => {
    for (const source of ["works-on", "pin", "auto-pin", "routine", "room"] as const) {
      expect(placeRowView(row(source, "cc-no-hours"), { role: "admin" }).action?.id, source).toBe("see-plan");
    }
  });

  it("stores the line and its action as words a phone can read", () => {
    expect(placeRowText({ state: "cc-no-hours", params: { bot: "Scout", hours: 50, month: "November" }, source: "works-on" }))
      .toBe("This month's 50 cloud computer hours are used up. They come back on 1 November. See your plan on the Plan page.");
    expect(placeRowText(row("auto-pin")))
      .toBe("Cloud computers can't start right now. It isn't anything you did. This conversation is back on Auto. Send your message again.");
    expect(placeRowText(row("routine"))).toBe("Cloud computers can't start right now. It isn't anything you did. Change where this routine runs.");
    expect(placeRowText(row("room"))).toBe("Cloud computers can't start right now. It isn't anything you did.");
    expect(placeRowText({ state: "cc-cannot", params: { bot: "Scout", model: "Llama" }, source: "works-on" }))
      .toBe("Llama can't use a computer. Choose a model that can, such as Claude or ChatGPT. Choose another model in Scout's settings.");
  });
});

describe("cloudRefusal reads the Admin's refusals", () => {
  const included = (message: string, code?: string, status?: number) => cloudRefusal({ message, code, status }, true);

  it("reads today's English, before the Admin sends its own codes", () => {
    expect(included("Your Pro plan's 50 cloud computer hours for October are used up. They reset on 1 November.", "limit_reached", 429))
      .toEqual({ state: "cc-no-hours", params: { plan: "Pro", hours: 50, month: "November" } });
    expect(included("Your Personal plan includes 1 cloud computer at once. Delete one to start another.", "limit_reached", 429))
      .toEqual({ state: "cc-at-once", params: { plan: "Personal", max: 1 } });
    expect(included("Your cloud computers were started too often. Try again in a minute.", "limit_reached", 429).state).toBe("cc-unavailable");
    expect(included("Cloud computers are busy right now. Try again in a few minutes.", "rate_limited", 429).state).toBe("cc-unavailable");
    expect(included("Cloud computers are temporarily unavailable. Try again later.", undefined, 503).state).toBe("cc-unavailable");
  });

  it("maps the existing inactive-plan code, and the codes the Admin is adding", () => {
    expect(included("Cloud computers are included with an active Cloud subscription.", "subscription_inactive", 402).state).toBe("cc-ended");
    expect(included("x", "hours_used").state).toBe("cc-no-hours");
    expect(included("x", "at_once").state).toBe("cc-at-once");
    expect(included("x", "too_many_starts").state).toBe("cc-unavailable");
  });

  it("reads this app's own start failures, and an own key's provider words", () => {
    expect(included("box did not become ready within 90s — retry in a minute").state).toBe("cc-no-start");
    expect(included("box desktop link could not be created").state).toBe("cc-no-start");
    expect(included("this cloud computer is being deleted — wait for it to finish, or retry Delete if it needs attention").state).toBe("cc-clearing");
    expect(cloudRefusal({ message: "Start the $20/month Boat plan to create sandboxes.", status: 402 }, false))
      .toEqual({ state: "cc-provider", params: { words: "Start the $20/month Boat plan to create sandboxes." } });
    expect(included("something new").state).toBe("cc-no-start");
  });
});
