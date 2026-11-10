import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SharedQueueLine, nextLine, workingForLabel } from "./SharedQueueLine";

const priya = { name: "Priya", id: "p_priya" }, tom = { name: "Tom", id: "p_tom" }, sam = { name: "Sam", id: "p_sam" };
const line = (waiting: Array<{ queueId: string; sender?: { name: string; id?: string } }>, viewer: string) =>
  renderToStaticMarkup(createElement(SharedQueueLine, { waiting, viewer, onRemove: () => {} }));

describe("the shared chat's quiet queue line", () => {
  it("says whose request runs", () => {
    expect(workingForLabel(priya, "p_tom")).toBe("Working on Priya's request");
    expect(workingForLabel(priya, "p_priya")).toBe("Working on your request");
    expect(workingForLabel(undefined, "p_tom")).toBeUndefined();
  });

  it("names only what runs next, and how many more wait", () => {
    expect(nextLine([], "p_priya")).toBeNull();
    expect(nextLine([{ queueId: "q1", sender: tom }], "p_priya")).toBe("Next: Tom's request");
    expect(nextLine([{ queueId: "q1", sender: tom }, { queueId: "q2", sender: sam }, { queueId: "q3", sender: priya }], "p_priya")).toBe("Next: Tom's request, then 2 more");
    expect(nextLine([{ queueId: "q1", sender: tom }], "p_tom")).toBe("Next: your request");
    expect(nextLine([{ queueId: "q1", sender: tom }, { queueId: "q2", sender: sam }], "p_tom")).toBe("Next: your request, then 1 more");
  });

  it("offers remove only to someone with a waiting message of their own", () => {
    const waiting = [{ queueId: "q1", sender: tom }, { queueId: "q2", sender: sam }];
    expect(line(waiting, "p_priya")).not.toContain("Remove your waiting message");
    expect(line(waiting, "p_sam")).toContain("Remove your waiting message");
    expect(line([], "p_sam")).toBe("");
  });
});
