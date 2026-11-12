import { describe, expect, it } from "vitest";

import { userBotMenu } from "./own-team-bot";

const RUI = "rui@acme.test", MARTA = "marta@acme.test";
const PRIVATE = { everyone: "none" as const, people: {} };

describe("a team User's bot menu", () => {
  it("offers Delete for a bot they look after while nobody else can use it", () => {
    expect(userBotMenu({ createdBy: RUI, yourAccess: "edit", access: PRIVATE }, RUI)).toEqual({ duplicate: true, delete: "own" });
  });

  it("shows Delete with the reason once the bot is shared: that is an admin's", () => {
    expect(userBotMenu({ createdBy: RUI, yourAccess: "edit", access: { everyone: "none", people: { [MARTA]: "chat" } } }, RUI).delete).toBe("shared");
    expect(userBotMenu({ createdBy: RUI, yourAccess: "edit", access: { everyone: "chat", people: {} } }, RUI).delete).toBe("shared");
  });

  it("offers no Delete for anyone else's bot, and a copy only of one they can edit", () => {
    expect(userBotMenu({ createdBy: MARTA, yourAccess: "edit", access: { everyone: "none", people: { [RUI]: "edit" } } }, RUI)).toEqual({ duplicate: true, delete: null });
    expect(userBotMenu({ createdBy: MARTA, yourAccess: "chat" }, RUI)).toEqual({ duplicate: false, delete: null });
    expect(userBotMenu({ createdBy: RUI, reportsTo: MARTA, yourAccess: "edit", access: { everyone: "none", people: { [RUI]: "edit" } } }, RUI).delete, "handed on").toBeNull();
    expect(userBotMenu({ createdBy: RUI, yourAccess: "edit", access: PRIVATE }, undefined).delete).toBeNull();
    expect(userBotMenu({ defaultBot: { person: RUI }, yourAccess: "edit" }, RUI), "their own MausBot is neither copied nor deleted").toEqual({ duplicate: false, delete: null });
  });
});
