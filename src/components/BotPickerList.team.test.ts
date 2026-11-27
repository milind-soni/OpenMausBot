import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import { setTeamPeople, teamBotName } from "@/state/team-people";
import { BotPickerList } from "./BotPickerList";

const helper = (id: string, person: string) => ({ id, threadId: `t-${id}`, name: "MausBot", title: "", description: "", notifications: true, color: "green", unread: false,
  messages: [], modelSelection: { instanceId: "x", model: "x" }, defaultBot: { person } }) as unknown as Bot;
const bots = [helper("mine", "olive@acme.test"), helper("ada", "ada@acme.test"), helper("ben", "ben@acme.test")];
const olive = { email: "olive@acme.test", name: "Olive", role: "owner", you: true as const };
const team = { people: [olive, { email: "ada@acme.test", name: "Ada", role: "member" }, { email: "ben@acme.test", name: "Ben", role: "admin" }], me: olive, admin: true, needsYou: [] };

afterEach(() => setTeamPeople(null));

it("names each teammate's MausBot for its person in a picker, and the viewer's own as it is", () => {
  setTeamPeople(team);
  const html = renderToStaticMarkup(createElement(BotPickerList, { bots, picked: new Set<string>(), onToggle: () => {}, emptyHint: "" }));
  expect(html.match(/role="checkbox" aria-label="[^"]*"/g)?.map((match) => match.slice(match.indexOf("aria-label")))).toEqual(['aria-label="MausBot"', 'aria-label="MausBot · Ada"', 'aria-label="MausBot · Ben"']);
});

it("names a MausBot whose person is not in the list by their address", () => {
  expect(teamBotName(helper("x", "dan.smith@acme.test"), team)).toBe("MausBot · Dan Smith");
  expect(teamBotName({ name: "Scout" }, team)).toBe("Scout");
});

it("leaves names alone off a team", () => {
  const html = renderToStaticMarkup(createElement(BotPickerList, { bots, picked: new Set<string>(), onToggle: () => {}, emptyHint: "" }));
  expect(html).not.toContain("·");
});
