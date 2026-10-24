import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChiefJobCancel, ChiefJobCancelActions, chiefJobRoots } from "./ChiefJobCancel";

describe("Chief job cancellation", () => {
  const roots = ["root-1"];
  it("shows a separate Cancel job action only for a writable Chief source job", () => {
    const render = (chief: boolean, canWrite = true) => renderToStaticMarkup(createElement(ChiefJobCancelActions,
      { chief, canWrite, roots, pending: null, onCancel: () => {} }));
    expect(render(true)).toContain("Cancel job");
    expect(render(false)).toBe(""); expect(render(true, false)).toBe("");
  });
  it("uses human source requests for overlapping job actions, with exact ids retained in tooltips", () => {
    const markup = renderToStaticMarkup(createElement(ChiefJobCancelActions, { chief: true, canWrite: true,
      roots: ["root-1", "root-2"], pending: null, sourceRequests: { "root-1": "Compare the vendor proposals", "root-2": "Keep the newer request running" }, onCancel: () => {} }));
    expect(markup).toContain("Cancel: Compare the vendor proposals");
    expect(markup).toContain("Cancel: Keep the newer request running");
    expect(markup).toContain("Cancel job root-1, including running hand-offs");
    expect(markup).toContain("truncate");
  });
  it("keeps a saved partial-cancellation warning visible after native terminal updates", () => {
    const markup = renderToStaticMarkup(createElement(ChiefJobCancel, { botId: "chief", threadId: "source", busy: false, waiting: false,
      receipts: [{ rootId: "root-1", state: "partial", activeIds: ["child"], stoppedIds: ["root-1"], errors: ["Unconfirmed"] }] }));
    expect(markup).toContain("Cancellation reported partial");
    expect(markup).toContain("Review the retained reports");
  });
  it("keeps an exact job action after ordinary Stop left one of its children working", () => {
    expect(chiefJobRoots({ roots: ["root-stopped"], nodes: [
      { id: "root-stopped", botId: "chief", threadId: "source", status: "cancelled" },
      { id: "child", rootId: "root-stopped", parentId: "root-stopped", botId: "expert", threadId: "work", status: "running" },
    ] }, "chief", "source")).toEqual(["root-stopped"]);
  });
  it("selects only nonterminal native source roots owned by this Chief conversation", () => {
    expect(chiefJobRoots({ roots: ["root-1", "other", "settled", "child"], nodes: [
      { id: "root-1", botId: "chief", threadId: "source", status: "waiting" },
      { id: "other", botId: "other-chief", threadId: "source", status: "running" },
      { id: "settled", botId: "chief", threadId: "source", status: "completed" },
      { id: "child", parentId: "parent", botId: "chief", threadId: "source", status: "running" },
    ] }, "chief", "source")).toEqual(["root-1"]);
  });
});
