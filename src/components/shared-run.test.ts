import { describe, expect, it } from "vitest";

import { mayActOn, workingForLabel } from "./shared-run";
import { stoppedWords } from "./CancelledTurnRow";
import { PERSON_STOPPED_TURN_NAME, STOPPED_TURN_NAME } from "../../shared/client-cancel";

const priya = { name: "Priya", id: "p_priya" };
describe("shared chat run ownership", () => {
  it("says whose request runs", () => {
    expect(workingForLabel(priya, "p_tom")).toBe("Working on Priya's request");
    expect(workingForLabel(priya, "p_priya")).toBe("Working on your request");
    expect(workingForLabel(undefined, "p_tom")).toBeUndefined();
  });

  it("names a person with no name set as the People list does", () => {
    expect(workingForLabel({ name: "mary-ann.lee@acme.test", id: "p_mary" }, "p_tom")).toBe("Working on Mary Ann Lee's request");
  });

  it("lets only the asker, an admin, or anyone for a run no person asked for, stop or retry", () => {
    expect(mayActOn(priya, "p_priya", false)).toBe(true);
    expect(mayActOn(priya, "p_tom", false)).toBe(false);
    expect(mayActOn(priya, "p_tom", true)).toBe(true);
    expect(mayActOn(undefined, "p_tom", false)).toBe(true);
    expect(mayActOn({ name: "Slack" }, "p_tom", false)).toBe(true);
  });

  it("says who stopped a run: their name to everyone else, you to them", () => {
    const maya = { name: "Maya Shah", id: "p_maya" };
    expect(stoppedWords(PERSON_STOPPED_TURN_NAME, maya, "p_priya")).toBe("Maya Shah stopped this.");
    expect(stoppedWords(PERSON_STOPPED_TURN_NAME, maya, "p_maya")).toBe("You stopped this.");
    expect(stoppedWords(PERSON_STOPPED_TURN_NAME, { name: "dev@acme.test", id: "p_dev" }, "p_priya")).toBe("Dev stopped this.");
    expect(stoppedWords(PERSON_STOPPED_TURN_NAME, undefined, "user")).toBe("You stopped this.");
    expect(stoppedWords(STOPPED_TURN_NAME, maya, "p_priya")).toBe("Stopped");
  });
});
