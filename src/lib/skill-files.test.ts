import { expect, it } from "vitest";

import { SKILL_FILE_ACCEPT, skillFilesOf } from "./skill-files";

const named = (name: string, type = "") => new File([`# ${name}`], name, { type });

it("keeps markdown and plain text, whatever the extension case", () => {
  const files = [named("SKILL.md"), named("notes.markdown"), named("README.MD"), named("copy.txt")];
  expect(skillFilesOf(files).map((file) => file.name)).toEqual(["SKILL.md", "notes.markdown", "README.MD", "copy.txt"]);
});

it("trusts a text MIME type when the name has no telling extension", () => {
  const file = new File(["# skill"], "SKILL", { type: "text/markdown" });
  expect(skillFilesOf([file])).toEqual([file]);
});

it("leaves images and archives from the same picker alone", () => {
  const picked = [named("SKILL.md"), named("diagram.png", "image/png"), named("skills.zip", "application/zip"), named("app.js")];
  expect(skillFilesOf(picked).map((file) => file.name)).toEqual(["SKILL.md"]);
});

it("answers an empty list for nothing chosen", () => {
  expect(skillFilesOf(null)).toEqual([]);
  expect(skillFilesOf(undefined)).toEqual([]);
  expect(skillFilesOf([])).toEqual([]);
});

it("asks the picker for markdown and plain text only", () => {
  expect(SKILL_FILE_ACCEPT).toContain(".md");
  expect(SKILL_FILE_ACCEPT).toContain(".markdown");
  expect(SKILL_FILE_ACCEPT).toContain("text/markdown");
  expect(SKILL_FILE_ACCEPT).toContain("text/plain");
  expect(SKILL_FILE_ACCEPT).not.toContain("image");
});
