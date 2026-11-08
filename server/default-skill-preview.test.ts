import { expect, it } from "vitest";
import { defaultSkillTemplates } from "./default-skill-preview.ts";

it("keeps bounded Markdown in new bot defaults and records omissions for preset export", () => {
  const result = defaultSkillTemplates([{ source: "fixture", files: [
    { path: "SKILL.md", content: Buffer.from("---\nname: example\ndescription: Example steps.\n---\nDo it.\n"), executable: false },
    { path: "references/guide.md", content: Buffer.from("Read me."), executable: false },
    { path: "template.html", content: Buffer.from("<p>fixture</p>"), executable: false },
  ], skipped: [{ path: "link", reason: "link" }] }]);
  expect(result).toMatchObject({ skills: [{ name: "example", files: [{ path: "references/guide.md", content: "Read me." }], omittedFiles: [
    { path: "template.html", reason: "skill_file_type" }, { path: "link", reason: "skill_file_unsafe" },
  ] }] });
});

it("rejects a fetched SKILL.md whose bytes are not UTF-8", () => {
  const result = defaultSkillTemplates([{ source: "fixture", files: [
    { path: "SKILL.md", content: Buffer.concat([Buffer.from("---\nname: example\ndescription: Example\n---\n"), Buffer.from([0xff])]), executable: false },
    { path: "guide.md", content: Buffer.from("Guide"), executable: false },
  ], skipped: [] }]);
  expect(result).toEqual({ error: "SKILL.md is not UTF-8 text" });
});
