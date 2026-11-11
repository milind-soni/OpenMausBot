import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SharedQueueLine, mayActOn, nextLine, workingForLabel } from "./SharedQueueLine";
import { stoppedWords } from "./CancelledTurnRow";
import { PERSON_STOPPED_TURN_NAME, STOPPED_TURN_NAME } from "../../shared/client-cancel";

const priya = { name: "Priya", id: "p_priya" }, tom = { name: "Tom", id: "p_tom" }, sam = { name: "Sam", id: "p_sam" };
const line = (waiting: Array<{ queueId: string; text: string; sender?: { name: string; id?: string } }>, viewer: string) =>
  renderToStaticMarkup(createElement(SharedQueueLine, { waiting, viewer, onRemove: () => {} }));

describe("the shared chat's quiet queue line", () => {
  it("says whose request runs", () => {
    expect(workingForLabel(priya, "p_tom")).toBe("Working on Priya's request");
    expect(workingForLabel(priya, "p_priya")).toBe("Working on your request");
    expect(workingForLabel(undefined, "p_tom")).toBeUndefined();
  });

  it("names only what runs next, and how many more wait", () => {
    const w = (queueId: string, sender: { name: string; id: string }) => ({ queueId, text: "", sender });
    expect(nextLine([], "p_priya")).toBeNull();
    expect(nextLine([w("q1", tom)], "p_priya")).toBe("Next: Tom's request");
    expect(nextLine([w("q1", tom), w("q2", sam), w("q3", priya)], "p_priya")).toBe("Next: Tom's request, then 2 more");
    expect(nextLine([w("q1", tom)], "p_tom")).toBe("Next: your request");
    expect(nextLine([w("q1", tom), w("q2", sam)], "p_tom")).toBe("Next: your request, then 1 more");
  });

  it("shows the writer their own waiting words with its remove control, and nobody else those words", () => {
    const waiting = [{ queueId: "q1", text: "What is due?", sender: tom }, { queueId: "q2", text: "Book the room", sender: sam }];
    const priyaSees = line(waiting, "p_priya");
    expect(priyaSees).not.toContain("Remove your waiting message");
    expect(priyaSees).not.toContain("What is due?");
    expect(priyaSees).not.toContain("Book the room");
    const samSees = line(waiting, "p_sam");
    expect(samSees).toContain("Remove your waiting message");
    expect(samSees).toContain("Yours: Book the room");
    expect(samSees).not.toContain("What is due?");
    expect(line([], "p_sam")).toBe("");
  });

  it("names a person with no name set as the People list does", () => {
    expect(nextLine([{ queueId: "q1", text: "", sender: { name: "dev@acme.test", id: "p_dev" } }], "p_priya")).toBe("Next: Dev's request");
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
