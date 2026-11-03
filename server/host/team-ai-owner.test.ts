import { expect, it } from "vitest";

import { personKey } from "../person-key.ts";
import { teamAiOwner } from "./team-ai-owner.ts";

const OLIVE = { email: "olive.smith@acme.test", role: "owner" as const };
const BEN = { email: "ben@acme.test", role: "admin" as const };

it("names the team's owner by the name they chose, else from their address, and nobody until they have opened the team", () => {
  const chosen = new Map([[personKey({ id: "", email: OLIVE.email }), "Olive"]]);
  expect(teamAiOwner([BEN, OLIVE], (person) => chosen.get(person))).toEqual({ email: OLIVE.email, name: "Olive" });
  expect(teamAiOwner([BEN, OLIVE], () => undefined)?.name).toBe("Olive Smith");
  expect(teamAiOwner([BEN, OLIVE], () => OLIVE.email)?.name, "an address is no chosen name").toBe("Olive Smith");
  expect(teamAiOwner([BEN], () => "Ben")).toBeNull();
});
