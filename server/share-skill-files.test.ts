import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readShareFolder } from "../shared/share-folder.ts";
import { admitSkillFiles, skillFilePathProblem as shareablePath } from "../shared/skill-files.ts";
import { createCommunityPublisher, type CommunitySubmission } from "./share-publish.ts";
import { createShareHost, readFolderFromDisk } from "./share.ts";
import { prepareSkillFolder, skillFilePathProblem as storablePath } from "./skill-folder.ts";
import type { BotRecord } from "./store.ts";

const SKILL = "---\nname: report\ndescription: Weekly report.\n---\n\n# Report\n\nRun scripts/report.py.\n";
const SCRIPT = "import os\ntoken = os.environ['REPORT_TOKEN']\nprint('ok')\n";
const KEY = `ghp_${"a".repeat(36)}`;
const folders: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-share-files-"));
  folders.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const helper = { id: "bot-1", name: "Reporter", title: "Reports", color: "blue" } as BotRecord;

function host(stored: Array<{ path: string; content: string | Uint8Array }> | null, submitted: CommunitySubmission[] = []) {
  const dataDir = scratch(), botFolder = scratch();
  const publisher = createCommunityPublisher({ access: () => ({ kind: "desktop", url: "https://admin.example.com/api/cloud/pages/token", token: "t" }) });
  return createShareHost({
    dataDir, bots: () => [helper], groups: () => [], routines: () => [], brief: () => undefined,
    collectTeamSkills: () => ({ ok: true, skipped: [], skillsByBot: new Map([["bot-1", [{ name: "report", description: "Weekly report.", instructions: SKILL, enabled: true }]]]) }),
    skillFiles: () => stored, picture: () => undefined, botFolder: (id) => join(botFolder, id),
    publisher: { ...publisher, submit: async (submission) => {
      submitted.push(submission);
      return { ok: true, link: "https://github.com/milind-soni/openmausbot-teams/tree/main/teams/reporter", prUrl: "https://github.com/milind-soni/openmausbot-teams/pull/1" };
    } },
    patch: () => {},
  });
}

describe("a skill's scripts in a template", () => {
  it("are a subset of what a skill folder stores: whatever may travel is kept whole when it is added", () => {
    const paths = ["run.py", "scripts/report.py", "a/b/c/d/e/f.txt", "a/b/c/d/e/f/g.txt", ".env", "x/.git/config", "node_modules/a.js", "venv/bin/x",
      "__pycache__/a.pyc", "con", "nul.txt", "a:b", "a|b", "trailing.", "SKILL.md", `${"n".repeat(130)}.txt`, "id_rsa", "ok-file.md"];
    for (const path of paths) if (shareablePath(path) === null) expect(storablePath(path), path).toBeNull();
    const admitted = admitSkillFiles(paths.map((path) => ({ path, content: "text\n" })));
    const prepared = prepareSkillFolder([{ path: "SKILL.md", content: SKILL }, ...admitted.files]);
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.files.map((file) => file.path).sort()).toEqual(admitted.files.map((file) => file.path).sort());
    expect(prepared.skipped).toEqual([]);
  });

  it("travel on export, with what was left out and why named on the card", () => {
    const share = host([
      { path: "scripts/report.py", content: new TextEncoder().encode(SCRIPT) },
      { path: "scripts/.env", content: "REPORT_TOKEN=abc" },
      { path: "scripts/call.sh", content: `curl -H "authorization: token ${KEY}"` },
      { path: "assets/logo.png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]) },
      { path: "prod.env", content: "A=1" },
    ]);
    const made = share.export({ scope: "bot", bot: helper }, []);
    expect(readFileSync(join(made.dir, "skills", "report", "scripts", "report.py"), "utf8")).toBe(SCRIPT);
    expect(made.card.skipped).toEqual(expect.arrayContaining([
      "report/scripts/.env, which is hidden", "report/scripts/call.sh, which looks like it holds a key or password",
      "report/assets/logo.png, which isn't a text file", "report/prod.env, which is named like a key or password file",
    ]));
    const folder = readShareFolder(readFolderFromDisk(made.dir));
    if (folder.kind !== "package") throw new Error("not a package");
    expect(folder.document.package.skills!.entries[0]!.files).toEqual([{ path: "scripts/report.py", content: SCRIPT }]);
    expect(JSON.stringify(folder.document)).not.toContain(KEY);
  });

  it("stay home when they changed since they came in", () => {
    const made = host(null).export({ scope: "bot", bot: helper }, []);
    expect(made.card.skipped).toContain("the files beside skill report, which changed since they came in");
    expect(readShareFolder(readFolderFromDisk(made.dir)).kind).toBe("package");
  });

  it("are read from a folder only when the manifest names them, never through a link", () => {
    const made = host([{ path: "scripts/report.py", content: SCRIPT }]).export({ scope: "bot", bot: helper }, []);
    writeFileSync(join(made.dir, "skills", "report", "notes.txt"), "not named");
    expect(Object.keys(readFolderFromDisk(made.dir)).sort()).toEqual(["bot.md", "skills/report/SKILL.md", "skills/report/scripts/report.py"]);
    const outside = scratch();
    writeFileSync(join(outside, "secret.py"), "print('outside')\n");
    rmSync(join(made.dir, "skills", "report", "scripts"), { recursive: true });
    mkdirSync(join(made.dir, "skills", "report", "scripts"));
    try {
      symlinkSync(join(outside, "secret.py"), join(made.dir, "skills", "report", "scripts", "report.py"));
    } catch {
      return;
    }
    expect(readFolderFromDisk(made.dir)).not.toHaveProperty("skills/report/scripts/report.py");
    expect(() => readShareFolder(readFolderFromDisk(made.dir))).toThrow(/but the file is missing/);
  });

  it("stay out of a community submission, whose check takes SKILL.md alone, and the published folder still reads", async () => {
    const submitted: CommunitySubmission[] = [];
    const share = host([{ path: "scripts/report.py", content: SCRIPT }], submitted);
    const made = share.export({ scope: "bot", bot: helper }, []);
    expect((await share.publish(made.card.id)).status).toBe("published");
    expect(Object.keys(submitted[0]!.files).sort()).toEqual(["bot.md", "skills/report/SKILL.md"]);
    expect(String(submitted[0]!.files["bot.md"])).not.toContain("skillFiles");
    expect(share.files(made.card.id).files).toHaveProperty(["skills/report/scripts/report.py"]);
  });
});
