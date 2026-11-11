import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundledSkills, selectBundledSkills } from "./skill-library.ts";

describe("social-posts skill guide", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));
  const guide = skills.find((skill) => skill.manifest.id === "social-posts")?.instructions ?? "";
  const ids = (text: string) => selectBundledSkills(text, [], skills).map((skill) => skill.manifest.id);

  it("mounts when a bot is asked for a social post, and stays out of other uses of the word post", () => {
    for (const text of ["Plan next week's posts for LinkedIn and X", "Draft three posts about our launch and add them to Postiz", "Write a LinkedIn post about hiring", "make me an Instagram carousel",
      "tweet this for me", "Plan next week's social posts from memory/social.md", "write a post about our launch", "a caption for an instagram reel", "write a post for x"]) {
      expect(ids(text), text).toContain("social-posts");
    }
    for (const text of ["post the invoice to accounting", "send a POST request to the API", "go to the post office", "write a blog post-mortem", "fix the box post", "the fence post is broken", "freely choose a reel of film", "write a post-mortem"]) {
      expect(ids(text), text).not.toContain("social-posts");
    }
  });

  it("keeps the guide short, in plain words, and pointing at its template", () => {
    expect(guide.split("\n").length).toBeLessThanOrEqual(95);
    expect(guide).not.toMatch(/\b(engines?|servers?)\b/i);
    expect(guide).toContain("posts.html");
    expect(guide).toContain("show_html");
    expect(guide).toContain("integrationSchema");
  });
});
