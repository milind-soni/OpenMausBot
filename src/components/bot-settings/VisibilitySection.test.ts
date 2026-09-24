import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import { formFromVisibility, mixedRooms, visibilityFromForm, VisibilitySection } from "./VisibilitySection";

const render = (target: Bot) => renderToStaticMarkup(createElement(StoreProvider, null, createElement(VisibilitySection, { bot: target })));

const bot = (visibility?: Bot["visibility"]) => ({ id: "b1", name: "Payroll", visibility } as unknown as Bot);

describe("bot visibility form", () => {
  it("round-trips the three settings", () => {
    expect(formFromVisibility(undefined)).toEqual({ mode: "everyone", people: "" });
    expect(formFromVisibility("everyone")).toEqual({ mode: "everyone", people: "" });
    expect(formFromVisibility("admins")).toEqual({ mode: "admins", people: "" });
    expect(formFromVisibility({ people: ["ada@example.test", "@acme.test"] })).toEqual({ mode: "people", people: "ada@example.test\n@acme.test" });
    expect(visibilityFromForm("everyone", "ignored")).toEqual({ ok: true, visibility: "everyone" });
    expect(visibilityFromForm("admins", "")).toEqual({ ok: true, visibility: "admins" });
    expect(visibilityFromForm("people", " Ada@Example.test,\n@acme.test ; ada@example.test ")).toEqual({ ok: true, visibility: { people: ["ada@example.test", "@acme.test"] } });
    // an empty list is refused here rather than saved as "admins only" by surprise
    expect(visibilityFromForm("people", " \n ")).toEqual({ ok: false });
  });

  it("names the rooms this bot shares with bots other people can see", () => {
    const bots = [
      { id: "b1", visibility: { people: ["Ada@example.test"] } },
      { id: "b2", visibility: undefined },
      { id: "b3", visibility: { people: ["ada@example.test"] } },
    ] as Array<Pick<Bot, "id" | "visibility">>;
    const groups = [
      { id: "g1", name: "Pay questions", memberIds: ["b1", "b2"] },
      { id: "g2", name: "HR desk", memberIds: ["b1", "b3"] },
      { id: "g3", name: "b1 ⇄ b2", memberIds: ["b1", "b2"], dm: true },
      // once narrower, still narrower: its floor outlived the bot that set it
      { id: "g4", name: "Old severance room", memberIds: ["b2"], audienceFloor: "admins" as const },
    ];
    expect(mixedRooms(bots[0]!, groups, bots)).toEqual([{ id: "g1", name: "Pay questions" }]);
    expect(mixedRooms(bots[2]!, groups, bots)).toEqual([]);
    expect(mixedRooms(bots[1]!, groups, bots).map((room) => room.id)).toEqual(["g1", "g4"]);
  });

  it("renders the stored choice, with the list when it names people", () => {
    const people = render(bot({ people: ["ada@example.test"] }));
    expect(people).toContain("Only these people");
    expect(people).toMatch(/checked="" value="people"/);
    expect(people).toContain("ada@example.test</textarea>");
    const everyone = render(bot());
    expect(everyone).toMatch(/checked="" value="everyone"/);
    expect(everyone).not.toContain("<textarea");
  });
});
