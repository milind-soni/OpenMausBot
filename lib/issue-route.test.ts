import { describe, expect, it } from "vitest";
import { issuePath, issuesForKey, keySuffix, legacyIssueParams, parseIssuePath } from "./issue-route";

const id = "k57c2h4w8x9m3n6p1q2r3s4t5v6w1a2b";

describe("issue page routes", () => {
  it("builds a canonical path with the readable key and the exact id", () => {
    expect(issuePath("acme", id)).toBe(`/acme/issue/ORI-1A2B/${id}`);
    expect(parseIssuePath(issuePath("acme", id))).toEqual({ slug: "acme", key: "ORI-1A2B", taskId: id });
  });
  it("reads key-only and workspace-less links", () => {
    expect(parseIssuePath("/acme/issue/ori-1a2b")).toEqual({ slug: "acme", key: "ORI-1A2B", taskId: undefined });
    expect(parseIssuePath("/issue/ORI-1A2B")).toEqual({ slug: null, key: "ORI-1A2B", taskId: undefined });
    expect(parseIssuePath(`/acme/issue/${id}`)).toEqual({ slug: "acme", key: "ORI-1A2B", taskId: id });
  });
  it("rejects paths that are not issue pages", () => {
    for (const path of ["/acme", "/acme/issue", "/acme/issue/ORI-1A2", "/acme/issue/BUG-1A2B", "/acme/issue/ORI-1A2B/x/y", "/acme/issue/ORI-1A2B/not-an-id!", "/acme/board/ORI-1A2B"]) expect(parseIssuePath(path)).toBeNull();
  });
  it("matches keys case-insensitively and reports every collision", () => {
    expect(keySuffix(" ori-1A2b ")).toBe("1a2b");
    expect(keySuffix("ORI-12345")).toBeNull();
    const tasks = [{ _id: `aaaa${id.slice(4)}` }, { _id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzz1a2b" }, { _id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzz9999" }];
    expect(issuesForKey(tasks, "ORI-1A2B").map(task => task._id)).toEqual([tasks[0]!._id, tasks[1]!._id]);
    expect(issuesForKey(tasks, "ORI-0000")).toEqual([]);
    expect(issuesForKey(tasks, "nonsense")).toEqual([]);
  });
  it("redirects old ?project=&issue= deep links", () => {
    expect(legacyIssueParams(`?project=p1&issue=${id}`)).toEqual({ projectId: "p1", taskId: id });
    expect(legacyIssueParams("?project=p1")).toBeNull();
    expect(legacyIssueParams("?project=p1&issue=../x")).toBeNull();
  });
});
