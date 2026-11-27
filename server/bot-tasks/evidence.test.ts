import { describe, expect, it } from "vitest";

import { BotTaskError, githubRefsIn, parseEvidence, parseRef, supportsDone, verifyEvidence } from "./evidence.ts";

describe("GitHub verification", () => {
  const ref = { repo: "octo/project", number: 17 };
  const settings = { repos: ["OCTO/project"] };
  const actions = "https://github.com/octo/project/actions/runs/123";

  it.each([
    ["success", "completed", "verified"],
    ["failure", "completed", "failed"],
    ["cancelled", "completed", "failed"],
    [null, "in_progress", "unverifiable"],
  ] as const)("classifies CI conclusion %s with status %s", async (conclusion, status, expected) => {
    const checked = await verifyEvidence({ kind: "ci_run", url: actions }, ref, settings, async (path) => {
      expect(path).toBe("/repos/octo/project/actions/runs/123");
      return { status, conclusion };
    }, 1);
    expect(checked.verification).toMatchObject({ status: expected, checkedAt: 1 });
    if (conclusion) expect(checked.verification?.detail).toContain(conclusion);
  });

  it("verifies a CI job only for the run the link names", async () => {
    const claim = { kind: "ci_run", url: `${actions}/job/456` } as const;
    const checked = await verifyEvidence(claim, ref, settings, async (path) => {
      expect(path).toBe("/repos/octo/project/actions/jobs/456");
      return { status: "completed", conclusion: "success", run_id: 123 };
    }, 1);
    expect(checked.verification?.status).toBe("verified");
    expect((await verifyEvidence(claim, ref, settings, async () => ({ run_id: 444 }), 1)).verification?.status).toBe("failed");
  });

  it.each([
    ["pull/17#pullrequestreview-5", "pulls/17/reviews/5"],
    ["pull/17#discussion_r5", "pulls/comments/5"],
    ["issues/17#issuecomment-5", "issues/comments/5"],
  ])("checks the %s anchor on the linked item", async (suffix, route) => {
    const url = `https://github.com/octo/project/${suffix}`;
    const claim = { kind: "review_url", url } as const;
    const checked = await verifyEvidence(claim, ref, settings, async (path) => {
      expect(path).toBe(`/repos/octo/project/${route}`);
      return { html_url: url };
    }, 1);
    expect(checked.verification?.status).toBe("verified");
    expect((await verifyEvidence(claim, ref, settings, async () => ({
      html_url: url.replace("/17#", "/18#"),
    }), 1)).verification?.status).toBe("failed");
  });

  it("does not call GitHub for unlinked CI, disallowed repositories, or URLs outside the linked repository", async () => {
    const lookup = async () => { throw new Error("unexpected lookup"); };
    const claim = { kind: "ci_run", url: actions } as const;
    expect((await verifyEvidence(claim, undefined, settings, lookup, 1)).verification).toMatchObject({
      status: "unverifiable", detail: "Evidence needs an allowed GitHub repository.",
    });
    expect((await verifyEvidence(claim, ref, { repos: [] }, lookup, 1)).verification).toMatchObject({
      status: "unverifiable", detail: "Evidence needs an allowed GitHub repository.",
    });
    expect((await verifyEvidence({ ...claim, url: "https://example.com/octo/project/actions/runs/123" }, ref, settings, lookup, 1)).verification?.status).toBe("failed");
  });
});

describe("evidence", () => {
  it("normalises a commit and keeps its repo", () => {
    expect(parseEvidence({ kind: "commit", sha: " 950E39042 ", repo: "Acme/Widgets" })).toEqual({ kind: "commit", sha: "950e39042", repo: "Acme/Widgets" });
  });

  it.each([
    [{ kind: "commit", sha: "12345" }],
    [{ kind: "commit", sha: "abcdefg" }],
    [{ kind: "commit", sha: "abcdef1", repo: "../x" }],
    [{ kind: "ci_run", url: "ftp://example.com/x" }],
    [{ kind: "ci_run", url: "https://user:pw@example.com/x" }],
    [{ kind: "review_url", url: "https://example.com/a/b/pull/1" }],
    [{ kind: "review_url", url: "https://github.com/a/b/tree/main" }],
    [{ kind: "command", command: "", exitCode: 0 }],
    [{ kind: "command", command: "x", exitCode: "0" }],
    [{ kind: "command", command: "x", exitCode: 0.5 }],
    [{ kind: "magic" }],
    ["abc"],
    [null],
  ])("refuses %j", (item) => {
    expect(() => parseEvidence(item)).toThrow(BotTaskError);
  });

  it("counts any proof except a failed command as support for done", () => {
    expect(supportsDone([])).toBe(false);
    expect(supportsDone([{ kind: "command", command: "x", exitCode: 2 }])).toBe(false);
    expect(supportsDone([{ kind: "command", command: "x", exitCode: 2 }, { kind: "commit", sha: "abcdef1", verification: { status: "verified", checkedAt: 1 } }])).toBe(true);
    expect(supportsDone([{ kind: "command", command: "x", exitCode: 0 }])).toBe(true);
  });
});

describe("GitHub references in text", () => {
  it("finds owner/repo#n and github.com links once each", () => {
    expect(githubRefsIn("see a/b#1, A/B#1 and https://github.com/c/d/pull/2 or https://github.com/c/d/issues/3")).toEqual([
      { repo: "c/d", number: 2, kind: "pull" }, { repo: "c/d", number: 3, kind: "issue" }, { repo: "a/b", number: 1 },
    ]);
  });

  it("ignores paths, versions and plain issue numbers", () => {
    expect(githubRefsIn("src/a/b#1 is not one, nor #12, v1.2.3#4, or http://github.com/a/b/pull/1")).toEqual([]);
  });

  it("parses exactly one reference", () => {
    expect(parseRef("Acme/Widgets#5")).toEqual({ repo: "Acme/Widgets", number: 5 });
    expect(() => parseRef("a/b#1 a/b#2")).toThrow(BotTaskError);
    expect(() => parseRef(5)).toThrow(BotTaskError);
  });
});
