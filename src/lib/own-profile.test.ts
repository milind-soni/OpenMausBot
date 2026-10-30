import { describe, expect, it } from "vitest";
import { otherSpeaker } from "./own-profile";

describe("whose line a person sees", () => {
  const ada = { role: "user", sender: { name: "Ada Lovelace", id: "p_ada" } };
  it("names another person's line on a team, and never the viewer's own", () => {
    expect(otherSpeaker(ada, "p_bob")).toBe("Ada Lovelace");
    expect(otherSpeaker(ada, "p_ada")).toBeNull();
  });
  it("names nothing where one person uses the server, nor a bot's or an unsigned line", () => {
    expect(otherSpeaker(ada, null)).toBeNull();
    expect(otherSpeaker({ role: "bot", sender: ada.sender }, "p_bob")).toBeNull();
    expect(otherSpeaker({ role: "user" }, "p_bob")).toBeNull();
    expect(otherSpeaker({ role: "user", sender: { name: "Someone" } }, "p_bob")).toBeNull();
  });
});
