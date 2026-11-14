import { describe, expect, it } from "vitest";

import { personKey } from "../person-key.ts";
import { lookedAfterBy } from "./looked-after.ts";

const ADA = "ada@acme.test";
const names: Record<string, string> = { [personKey({ id: "", email: ADA })]: "Ada Lovelace" };

describe("who looks after a team bot, by name", () => {
  it("names the member the bot reports to, from their team profile, else from their address", () => {
    expect(lookedAfterBy({ reportsTo: ADA, createdBy: "ben@acme.test" }, (person) => names[person])).toBe("Ada Lovelace");
    expect(lookedAfterBy({ createdBy: "ben.ray@acme.test" }, (person) => names[person])).toBe("Ben Ray");
    expect(lookedAfterBy({ createdBy: ADA }, () => ADA)).toBe("Ada");
  });

  it("names nobody for a bot nobody owns", () => {
    expect(lookedAfterBy({}, (person) => names[person])).toBeNull();
  });
});
