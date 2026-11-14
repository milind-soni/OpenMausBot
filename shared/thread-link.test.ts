import { describe, expect, it } from "vitest";
import { lastChangeRequestUrl, threadLinkLabel, threadLinkUrl } from "./thread-link";

describe("thread links", () => {
  it("accepts only http(s) addresses", () => {
    expect(threadLinkUrl(" https://github.com/o/r/pull/12 ")).toBe("https://github.com/o/r/pull/12");
    expect(threadLinkUrl("https://example.com")).toBe("https://example.com/");
    expect(threadLinkUrl("javascript:alert(1)")).toBeNull();
    expect(threadLinkUrl("file:///etc/passwd")).toBeNull();
    expect(threadLinkUrl("not a url")).toBeNull();
    expect(threadLinkUrl(42)).toBeNull();
    expect(threadLinkUrl(`https://example.com/${"a".repeat(2_048)}`)).toBeNull();
    expect(threadLinkUrl(`https://example.com/${"é".repeat(1_000)}`)).toBeNull();
  });

  it("labels pull requests, issues, merge requests and nothing else", () => {
    expect(threadLinkLabel("https://github.com/o/r/pull/123")).toBe("#123");
    expect(threadLinkLabel("https://github.com/o/r/pull/123/files")).toBe("#123");
    expect(threadLinkLabel("https://github.com/o/r/issues/7")).toBe("#7");
    expect(threadLinkLabel("https://gitlab.com/group/sub/repo/-/merge_requests/45")).toBe("!45");
    expect(threadLinkLabel("https://www.linear.app/team/issue/ABC-1")).toBeNull();
  });

  it("finds the last pull or merge request a reply names", () => {
    expect(lastChangeRequestUrl("Opened https://github.com/o/r/pull/1 then [#2](https://github.com/o/r/pull/2/files).")).toBe("https://github.com/o/r/pull/2");
    expect(lastChangeRequestUrl("See https://gitlab.example.com/g/r/-/merge_requests/9, done")).toBe("https://gitlab.example.com/g/r/-/merge_requests/9");
    expect(lastChangeRequestUrl("https://github.com/o/r/pull/1 then https://github.com/o/r/pull/12abc")).toBe("https://github.com/o/r/pull/1");
    expect(lastChangeRequestUrl("https://gitlab.example.com/g/r/-/merge_requests/9x")).toBeNull();
    expect(lastChangeRequestUrl("Issue https://github.com/o/r/issues/3 and https://example.com")).toBeNull();
  });
});
