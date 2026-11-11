import { describe, expect, test } from "vitest";
import { issueKey, pullRequestReferences, textReferences } from "./github-references";

describe("issue references in pull requests and commits", () => {
  test("an issue key in the branch or title links and closes", () => {
    expect(pullRequestReferences({ branch: "origin/ORI-AB12-fix-login", title: "Fix login", body: "" })).toEqual([{ kind: "key", key: "ORI-AB12", closes: true }]);
    expect(pullRequestReferences({ branch: "feature", title: "ori-zz99: tidy", body: null })).toEqual([{ kind: "key", key: "ORI-ZZ99", closes: true }]);
  });

  test("closing keywords close; linking keywords and bare mentions only link", () => {
    const refs = textReferences("Closes ORI-AAAA, ORI-BBBB and #12\nRefs ORI-CCCC\nSee also ORI-DDDD. Part of #13");
    expect(refs).toEqual(expect.arrayContaining([
      { kind: "key", key: "ORI-AAAA", closes: true },
      { kind: "key", key: "ORI-BBBB", closes: true },
      { kind: "number", number: 12, closes: true },
      { kind: "key", key: "ORI-CCCC", closes: false },
      { kind: "number", number: 13, closes: false },
      { kind: "key", key: "ORI-DDDD", closes: false },
    ]));
    expect(refs).toHaveLength(6);
  });

  test("a bare #number is not an Origin reference, and lookalikes do not match", () => {
    expect(textReferences("Bumps deps (#45). See owner/repo#9 and XORI-ABCD or ORI-ABCDE")).toEqual([]);
  });

  test("Origin issue links resolve by issue id", () => {
    const id = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
    expect(textReferences(`Fixes https://origin.example.com/team?project=p1&issue=${id}`)).toEqual([{ kind: "id", id, closes: true }]);
    expect(textReferences(`context: https://origin.example.com/team?project=p1&issue=${id}`)).toEqual([{ kind: "id", id, closes: false }]);
  });

  test("a target mentioned twice closes when any mention closes", () => {
    expect(pullRequestReferences({ branch: "main-work", title: "Work on ORI-AB12", body: "refs ORI-AB12\nfixes #4\nrefs #4" }))
      .toEqual([{ kind: "key", key: "ORI-AB12", closes: true }, { kind: "number", number: 4, closes: true }]);
  });

  test("the key matches the one Origin shows", () => {
    expect(issueKey("k57abcdefgh12xy")).toBe("ORI-12XY");
  });
});
