import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { PROFILE_FILE_MAX_BYTES, PROFILE_FOLDER_MAX_ENTRIES, PROFILE_FOLDER_MAX_FILES, PROFILE_MAX_PROBLEMS, problemSentence } from "../../shared/profile-format.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { loadProfileFolder, ProfileFolderError } from "./load.ts";

const ACME = join(import.meta.dirname, "..", "testing", "fixtures", "profiles", "acme");
const scratch = mkdtempSync(join(tmpdir(), "omb-profiles-"));
afterAll(() => removeTempDir(scratch));

let n = 0;
function acme(): string {
  const dir = join(scratch, `acme-${++n}`);
  cpSync(ACME, dir, { recursive: true });
  return dir;
}
const write = (dir: string, path: string, text: string | Buffer) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const links = it.skipIf(process.platform === "win32");
const sentences = (dir: string) => loadProfileFolder(dir).problems.map(problemSentence);

describe("loadProfileFolder", () => {
  it("reads the acme fixture: one organization, two areas, three bots, a skill and an MCP server", () => {
    const folder = loadProfileFolder(ACME);
    expect(folder.problems).toEqual([]);
    expect(folder.warnings).toEqual([]);
    expect(folder.org).toMatchObject({ name: "Acme", maxApproval: "auto", mcpServers: ["notion"] });
    expect(folder.areas.map((area) => [area.key, area.name])).toEqual([["bi", "BI"], ["sales", "Sales"]]);
    expect(folder.skills.map((skill) => skill.name)).toEqual(["weekly-report"]);
    expect(folder.mcpServers).toEqual([expect.objectContaining({ key: "notion", headers: { Authorization: { secret: "NOTION_TOKEN" } } })]);
    expect(folder.bots).toEqual([
      expect.objectContaining({
        id: "bi/analyst", name: "Analista BI", chief: true, model: "claude/claude-sonnet-5-5", effort: "medium", approval: "auto",
        eduBrain: { mode: "area" }, eduCrew: true, memory: { upkeep: true }, mcpServers: ["notion"],
        tools: { allow: ["native:*", "mcp:edu:*", "mcp:notion:*"] },
        skills: [{ name: "weekly-report", file: "areas/bi/skills/weekly-report/SKILL.md", enabled: true }],
        from: { model: "org", effort: "area", approval: "bot", tools: "area", eduBrain: "area", eduCrew: "bot", memory: "bot" },
      }),
      expect.objectContaining({ id: "bi/reporter", chief: false, approval: "ask", eduCrew: false, toolsOff: ["images"], from: expect.objectContaining({ approval: "org", toolsOff: "bot" }) }),
      expect.objectContaining({
        id: "sales/closer", model: "codex/gpt-5.5", approval: "edits",
        eduBrain: { mode: "cloud", url: "https://brain.acme.example/mcp", token: { secret: "EDU_CLOUD_SALES" } },
        connectors: { gmail: { tools: ["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT"] } },
      }),
    ]);
    expect(folder.bots[0]!.soul).toBe("You are the BI area's analyst.\n\nCheck every number against its source before you report it.");
  });

  it("throws only when the folder itself cannot be opened", () => {
    expect(() => loadProfileFolder(join(scratch, "missing"))).toThrow(new ProfileFolderError(`${join(scratch, "missing")} does not exist`));
    const file = join(scratch, "a-file");
    writeFileSync(file, "x");
    expect(() => loadProfileFolder(file)).toThrow(`${file} is not a folder`);
  });

  links("follows a link to the folder itself, the one the person chose", () => {
    const link = join(scratch, "acme-link");
    symlinkSync(ACME, link);
    expect(loadProfileFolder(link).problems).toEqual([]);
  });

  it("points to an edubot folder inside the one chosen", () => {
    const dir = join(scratch, `repo-${++n}`);
    cpSync(ACME, join(dir, "edubot"), { recursive: true });
    expect(sentences(dir)).toEqual([`.: has no profiles of its own, but its edubot folder may: check ${join(dir, "edubot")}`]);
  });

  it("reads CRLF files like LF files", () => {
    const dir = acme();
    write(dir, "areas/bi/bots/reporter.md", "---\r\nedubot: 1\r\nkind: bot\r\nkey: reporter\r\nname: Reporter\r\n---\r\nWrite the report.\r\n");
    const folder = loadProfileFolder(dir);
    expect(folder.problems).toEqual([]);
    expect(folder.bots.find((bot) => bot.key === "reporter")!.soul).toBe("Write the report.");
  });

  describe("refuses", () => {
    links("a linked file, a linked folder and a linked skill, without reading through them", () => {
      const dir = acme();
      const outside = join(scratch, `outside-${++n}`);
      write(outside, "bots/spy.md", "---\nedubot: 1\nkind: bot\nkey: spy\nname: Spy\n---\n");
      write(outside, "skill/SKILL.md", "---\nname: spy\ndescription: Spy.\n---\n");
      symlinkSync(join(outside, "bots", "spy.md"), join(dir, "areas", "bi", "bots", "spy.md"));
      symlinkSync(join(outside, "bots"), join(dir, "areas", "sales", "bots-link"));
      symlinkSync(join(outside, "skill"), join(dir, "areas", "bi", "skills", "spy"));
      symlinkSync(join(outside, "bots"), join(dir, "mcp", "more.md"));
      const folder = loadProfileFolder(dir);
      expect(folder.problems.map(problemSentence)).toEqual([
        "areas/bi/bots/spy.md: is a link; profiles never follow links, so put the file itself in the folder",
        "areas/bi/skills/spy: is a link; profiles never follow links, so put the file itself in the folder",
        "areas/sales/bots-link: is a link; profiles never follow links, so put the file itself in the folder",
        "mcp/more.md: is a link; profiles never follow links, so put the file itself in the folder",
      ]);
      expect(folder.bots.map((bot) => bot.key)).not.toContain("spy");
    });

    links("a linked areas folder", () => {
      const dir = join(scratch, `linked-areas-${++n}`);
      mkdirSync(dir);
      symlinkSync(join(ACME, "areas"), join(dir, "areas"));
      expect(sentences(dir)).toEqual([
        "areas: is a link; profiles never follow links, so put the file itself in the folder",
        ".: has no profiles: expected org.md or areas/<key>/area.md (docs/profiles.md)",
      ]);
    });

    it("a file over the size cap", () => {
      const dir = acme();
      write(dir, "areas/bi/bots/reporter.md", `---\nedubot: 1\nkind: bot\nkey: reporter\nname: Reporter\n---\n${"x".repeat(PROFILE_FILE_MAX_BYTES)}\n`);
      expect(sentences(dir)).toEqual(["areas/bi/bots/reporter.md: is larger than 256 KB"]);
    });

    it("a folder over the total size cap, and stops reading", () => {
      const dir = acme();
      for (let i = 0; i < 17; i++) write(dir, `mcp/m${i}.md`, `---\nedubot: 1\n---\n${"x".repeat(250 * 1024)}\n`);
      expect(sentences(dir)).toEqual([expect.stringMatching(/^\.: has profile files larger than 4 MB together; the check stopped at mcp\/m\d+\.md$/)]);
    });

    it("a folder with too many files", () => {
      const dir = acme();
      for (let i = 0; i <= PROFILE_FOLDER_MAX_FILES; i++) write(dir, `mcp/m${i}.md`, "");
      expect(sentences(dir)).toEqual([`.: has ${PROFILE_FOLDER_MAX_FILES + 9} profile files; the most a folder may have is ${PROFILE_FOLDER_MAX_FILES}`]);
    });

    it("a layout with too many files and folders, before it lists them all", () => {
      const dir = acme();
      for (let i = 0; i <= PROFILE_FOLDER_MAX_ENTRIES; i++) write(dir, `areas/bi/note-${i}.txt`, "");
      const folder = loadProfileFolder(dir);
      expect(folder.problems.map(problemSentence)).toEqual([`.: has more than ${PROFILE_FOLDER_MAX_ENTRIES} files and folders in its layout, so the check stopped at areas/bi`]);
      expect(folder.bots).toEqual([]);
    });

    it("a file that is not UTF-8", () => {
      const dir = acme();
      write(dir, "areas/bi/bots/reporter.md", Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]));
      expect(sentences(dir)).toEqual(["areas/bi/bots/reporter.md: is not UTF-8 text; save it as UTF-8"]);
    });

    it("a skill folder without SKILL.md", () => {
      const dir = acme();
      write(dir, "areas/bi/skills/empty/notes.txt", "x");
      expect(sentences(dir)).toEqual(["areas/bi/skills/empty: has no SKILL.md"]);
    });

    it("a mistake in a file, naming the file, line and field", () => {
      const dir = acme();
      write(dir, "areas/sales/bots/closer.md", "---\nedubot: 1\nkind: bot\nkey: closer\nname: Closer\ncwd: /home/ana/sales\n---\n");
      expect(sentences(dir)).toEqual([
        "areas/sales/bots/closer.md, line 6: cwd is chosen by each person in the app (a working folder is a path on one computer), so it never goes in a profile",
      ]);
    });
  });

  it("keeps at most PROFILE_MAX_PROBLEMS warnings", () => {
    const dir = acme();
    for (let i = 0; i < 250; i++) write(dir, `areas/bi/note-${i}.txt`, "");
    const folder = loadProfileFolder(dir);
    expect(folder.problems).toEqual([]);
    expect(folder.warnings).toHaveLength(PROFILE_MAX_PROBLEMS);
  });

  it("warns about files the layout has no place for, and skips hidden ones", () => {
    const dir = acme();
    write(dir, "areas/bi/notes.md", "x");
    write(dir, "areas/bi/bots/README.txt", "x");
    write(dir, "mcp/notion.yaml", "x");
    write(dir, "areas/bi/.DS_Store", "x");
    write(dir, ".git/config", "x");
    write(dir, "README.md", "x");
    const folder = loadProfileFolder(dir);
    expect(folder.problems).toEqual([]);
    expect(folder.warnings.map(problemSentence)).toEqual([
      "areas/bi/bots/README.txt: is not a profile file, so it is ignored",
      "areas/bi/notes.md: is not a profile file, so it is ignored",
      "mcp/notion.yaml: is not a profile file, so it is ignored",
    ]);
  });
});
