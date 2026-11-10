import { expect, it } from "vitest";
import { defaultSkillTemplates } from "./default-skill-preview.ts";

it("keeps bounded text and binary companions in new bot defaults and records omissions", () => {
  const result = defaultSkillTemplates([{ source: "fixture", files: [
    { path: "SKILL.md", content: Buffer.from("---\nname: example\ndescription: Example steps.\n---\nDo it.\n"), executable: false },
    { path: "references/guide.md", content: Buffer.from("Read me."), executable: false },
    { path: "template.html", content: Buffer.from("<p>fixture</p>"), executable: false },
    { path: "assets/example.bin", content: Buffer.from([0, 255]), executable: false },
  ], skipped: [{ path: "link", reason: "link" }] }]);
  expect(result).toMatchObject({ skills: [{ name: "example", files: [
    { path: "assets/example.bin", binary: { base64: "AP8=" } }, { path: "references/guide.md", content: "Read me." },
    { path: "template.html", content: "<p>fixture</p>" },
  ], omittedFiles: [
    { path: "link", reason: "skill_file_unsafe" },
  ] }] });
});

it("rejects a fetched SKILL.md whose bytes are not UTF-8", () => {
  const result = defaultSkillTemplates([{ source: "fixture", files: [
    { path: "SKILL.md", content: Buffer.concat([Buffer.from("---\nname: example\ndescription: Example\n---\n"), Buffer.from([0xff])]), executable: false },
    { path: "guide.md", content: Buffer.from("Guide"), executable: false },
  ], skipped: [] }]);
  expect(result).toEqual({ error: "SKILL.md is not UTF-8 text" });
});

it("keeps a skill when an omitted path is longer than the stored preview limit", () => {
  const longPath = Array.from({ length: 3 }, () => "a".repeat(200)).join("/") + ".md";
  const result = defaultSkillTemplates([{ source: "fixture", files: [
    { path: "SKILL.md", content: Buffer.from("---\nname: example\ndescription: Example steps.\n---\nDo it.\n"), executable: false },
    { path: longPath, content: Buffer.from("omitted"), executable: false },
  ], skipped: [] }]);
  expect(result).toMatchObject({ skills: [{ name: "example", omittedFiles: [{ path: expect.any(String), reason: "skill_file_unsafe" }] }] });
  if ("error" in result) throw new Error(result.error);
  expect(result.skills[0]!.omittedFiles![0]!.path).toHaveLength(512);
  expect(result.skills[0]!.omittedFiles![0]!.path).toMatch(/…$/);
});
