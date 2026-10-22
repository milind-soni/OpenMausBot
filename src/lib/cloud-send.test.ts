import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { moveLine } from "./cloud-send";

beforeEach(() => { setLocale("en"); });
afterEach(() => { setLocale("en"); });

describe("the one-time move's line", () => {
  it("says where the move is on whichever page is open, and who it waits for", () => {
    expect(moveLine({ phase: "copy" }, "local")).toMatchObject({ kind: "sending", text: "Moving your bots to My Cloud…" });
    expect(moveLine({ phase: "copy", chats: { done: 34, total: 120 } }, "local")?.text).toBe("Moving your bots to My Cloud… 34 of 120 chats");
    expect(moveLine({ phase: "copy", chats: { done: 34, total: 120 } }, "cloud")?.text).toBe("Bringing this computer's bots to My Cloud… 34 of 120 chats");
    expect(moveLine({ phase: "wait", waitingFor: "Scout" }, "local")?.text).toBe("Moving your bots to My Cloud… waiting for Scout to finish");
    expect(moveLine({ phase: "wait", waitingFor: "" }, "local")?.text).toBe("Moving your bots to My Cloud… waiting for your bots to finish");
    expect(moveLine({ phase: "finishing" }, "cloud")).toMatchObject({ kind: "sending", text: "Moving to My Cloud… almost done" });
  });

  it("with My Cloud too old to take a move, says it is updating and the move starts after, on either page", () => {
    for (const page of ["local", "cloud"] as const) {
      expect(moveLine({ phase: "copy", updating: true }, page)).toEqual({ kind: "sending", text: "My Cloud is updating. Your move starts when it's done.", extra: [] });
    }
  });

  it("after a day of failing says why, with Try again", () => {
    expect(moveLine({ phase: "copy", failing: { error: "My Cloud did not answer." } }, "local")).toMatchObject({ kind: "failed", text: "Your bots couldn't move to My Cloud yet: My Cloud did not answer.", retry: true });
    expect(moveLine({ phase: "finishing", failing: { error: null } }, "local")?.text).toBe("Your bots couldn't move to My Cloud yet.");
  });

  it("says once on My Cloud's page what arrived, a key kept for after the trial, and the phone to pair; on this computer, coming home", () => {
    const done = moveLine({ phase: "done", counts: { bots: 4, skills: 2, logins: 2, onePassword: true, chats: 148, routines: 2 }, phone: true, held: ["OpenRouter"] }, "cloud");
    expect(done).toMatchObject({ kind: "done", text: "Everything from this computer is here: 4 bots, 2 skills, 2 logins, 1Password, 148 chats, and 2 routines.", phone: true,
      extra: ["Your OpenRouter key is saved on My Cloud. Your bots use it once the trial's Claude credit runs out."] });
    expect(moveLine({ phase: "done", phone: false, held: [] }, "cloud")).toMatchObject({ text: "Everything from this computer is here.", extra: [] });
    expect(moveLine({ phase: "done", phone: true, held: [] }, "local"), "the done line is My Cloud's").toBeNull();
    expect(moveLine({ phase: "home-again" }, "local")?.text).toContain("your bots are back on this computer");
    expect(moveLine({ phase: "back", lost: true }, "local")?.text).toContain("couldn't come back");
    expect(moveLine({ phase: "back" }, "cloud")).toBeNull();
  });

  it("is in every language's own words", () => {
    setLocale("de");
    expect(moveLine({ phase: "copy" }, "local")?.text).toBe("Deine Bots ziehen in die Cloud um…");
    expect(moveLine({ phase: "copy", updating: true }, "local")?.text).toBe("My Cloud wird gerade aktualisiert. Dein Umzug beginnt, sobald das erledigt ist.");
  });
});

describe("the line on a computer whose bots came home to another one", () => {
  const since = Date.UTC(2026, 9, 21, 12);
  it("names that computer and the date of this computer's own copy, with automations off, and closes like the others", () => {
    expect(moveLine({ phase: "back", elsewhere: { name: "MacBook Air", since } }, "local"))
      .toEqual({ kind: "done", text: "Your bots came back to MacBook Air. This computer keeps its copy from October 21, 2026, with automations off.", extra: [] });
    expect(moveLine({ phase: "back", elsewhere: { name: "MacBook Air" } }, "local")?.text, "a copy already deleted is not offered").toBe("Your bots came back to MacBook Air.");
    expect(moveLine({ phase: "back", elsewhere: { name: "MacBook Air", since } }, "cloud")).toBeNull();
    setLocale("de");
    expect(moveLine({ phase: "back", elsewhere: { name: "MacBook Air", since } }, "local")?.text)
      .toBe("Deine Bots sind zurück auf MacBook Air. Dieser Computer behält seine Kopie vom 21. Oktober 2026, mit ausgeschalteten Automatisierungen.");
  });
});
