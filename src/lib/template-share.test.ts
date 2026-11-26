// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addedLine, countsLine, creditShown, folderFiles, scrubbedLine, TEMPLATE_FOLDER_MAX_BYTES } from "./template-share";
import { templateDetailsOf } from "./template-details";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "shared", "package-fixtures", name), "utf8"));
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const inFolder = (file: File, path: string) => Object.defineProperty(file, "webkitRelativePath", { value: path });

describe("a template's words", () => {
  it("counts only what it has, and bots only for a department", () => {
    expect(countsLine({ scope: "bot", counts: { bots: 1, skills: 0, routines: 1, apps: 2 } })).toBe("1 routine (paused) · 2 apps");
    expect(countsLine({ scope: "department", counts: { bots: 1, skills: 1, routines: 0, apps: 0 } })).toBe("1 bot · 1 skill");
    expect(addedLine({ appsToConnect: 0 })).toBe("Added");
    expect(addedLine({ appsToConnect: 3 })).toBe("Added · 3 apps to connect");
  });

  it("says what was taken out in one sentence, and nothing when nothing was", () => {
    expect(scrubbedLine({ scrubbed: { paths: 3, emails: 1, phones: 0, names: 0 } })).toBe("We removed 3 local paths and 1 email before publishing");
    expect(scrubbedLine({ scrubbed: { paths: 0, emails: 2, phones: 1, names: 0 } })).toBe("We removed 2 emails and 1 phone number before publishing");
    expect(scrubbedLine({ scrubbed: { paths: 0, emails: 0, phones: 0, names: 0 } })).toBe("");
    expect(scrubbedLine({})).toBe("");
  });

  it("shows a credit only when it names somebody", () => {
    expect(creditShown(" Jane Doe ")).toBe("Jane Doe");
    for (const nobody of [undefined, "", " ", "Community", "MausBot community", "MausBot user", "mausbot USER"]) expect(creditShown(nobody)).toBeNull();
  });
});

describe("a folder chosen in a browser", () => {
  it("keeps its Markdown as text and its pictures as data: links, by their place in the folder, and nothing else", async () => {
    const files = await folderFiles([
      inFolder(new File(["---\nbotmrr: 2\n---\n"], "bot.md"), "quill/bot.md"),
      inFolder(new File(["---\nname: follow-up\n---\n"], "SKILL.md"), "quill/skills/follow-up/SKILL.md"),
      inFolder(new File([PNG], "quill.png", { type: "image/png" }), "quill/avatars/quill.png"),
      inFolder(new File(["x"], ".DS_Store"), "quill/.DS_Store"),
      inFolder(new File(["#!/bin/sh"], "run.sh"), "quill/run.sh"),
    ]);
    expect(Object.keys(files).sort()).toEqual(["quill/avatars/quill.png", "quill/bot.md", "quill/skills/follow-up/SKILL.md"]);
    expect(files["quill/bot.md"]).toContain("botmrr: 2");
    expect(files["quill/avatars/quill.png"]).toMatch(/^data:image\/png;base64,/);
  });

  it("refuses a folder over 4 MB before reading it", async () => {
    await expect(folderFiles([new File([new Uint8Array(TEMPLATE_FOLDER_MAX_BYTES + 1)], "team.md")])).rejects.toThrow("larger than 4 MB");
  });
});

describe("a gallery team's details", () => {
  it("reads a shared department with its lead, skills, paused routines and apps", () => {
    const details = templateDetailsOf(fixture("full-team.v2.json"));
    expect(details).toMatchObject({ scope: "department", name: "Sales desk" });
    expect(details.bots.some((bot) => bot.lead)).toBe(true);
    expect(details.bots.map((bot) => bot.name)).toContain("Scout");
  });

  it("reads a legacy team file by its members", () => {
    expect(templateDetailsOf({ format: "openmaus.team", version: 2, team: { name: "Sales crew", members: [{ key: "a", name: "Lead finder", appearance: { color: "cyan" } }] } }))
      .toMatchObject({ name: "Sales crew", bots: [{ name: "Lead finder", color: "cyan" }] });
  });

  it("refuses anything else with a sentence", () => {
    expect(() => templateDetailsOf({ hello: "world" })).toThrow("This isn't a template.");
  });
});
