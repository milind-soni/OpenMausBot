import { describe, expect, it } from "vitest";

import { canonicalJson, PackageFormatError, packageSecretFindings, parsePackageDocument, redactPackageSecrets } from "./package-format.ts";
import { namedFolderFiles, normalizeShareFolder, readShareFolder, writeShareFolder } from "./share-folder.ts";
import { admitSkillFiles, SKILL_FILE_LIMITS, skillFilePathProblem, skillFileProblem, skillFileText } from "./skill-files.ts";

const skillMd = (name: string) => `---\nname: ${name}\ndescription: ${name} steps.\n---\n\n# ${name}\n\nRun scripts/report.py.\n`;
const SCRIPT = "import os\ntoken = os.environ['REPORT_TOKEN']\nprint('report')\n";
const KEY = `sk-ant-api03-${"A".repeat(40)}`;

function withFiles(files: Array<{ path: string; content: string }>) {
  return {
    format: "openmaus.package", version: 2,
    package: {
      id: "reporter", release: "1.0.0", name: "Reporter", tagline: "Writes reports.", summary: "Writes reports.", category: "Community",
      author: { name: "MausBot user" }, license: "Unspecified", outcomes: ["Reports."], setupMinutes: 2,
      requirements: { apps: [], capabilities: [] }, team: { name: "Reporter" },
      agents: [{ key: "reporter", name: "Reporter", appearance: { color: "blue" }, skills: ["report"] }],
      skills: { version: 1, entries: [{ name: "report", description: "report steps.", instructions: skillMd("report"), files }] },
    },
  };
}

describe("files beside a skill", () => {
  it("takes plain relative paths and refuses hidden, generated, deep, odd and key-file names", () => {
    for (const path of ["run.py", "scripts/report.py", "references/guide.md", "templates/a/b/c/d.txt", "Makefile"]) expect(skillFilePathProblem(path), path).toBeNull();
    expect(skillFilePathProblem(".env")).toBe("hidden");
    expect(skillFilePathProblem("scripts/.cache/x")).toBe("hidden");
    expect(skillFilePathProblem("node_modules/x/index.js")).toBe("generated");
    expect(skillFilePathProblem("scripts/__pycache__/a.pyc")).toBe("generated");
    expect(skillFilePathProblem("a/b/c/d/e/f/g.txt")).toBe("deep");
    for (const path of ["../x", "a//b", "/abs", "a\\b", "con.txt", "x.", "SKILL.md", "docs/skill.md", "a:b"]) expect(skillFilePathProblem(path), path).toBe("name");
    for (const path of ["prod.env", "env", "env.local", "id_rsa", "server.pem", "api.key", "credentials.json", "secrets.yaml", "app-secrets.json", "tokens.json",
      "service-account-prod.json", "auth.json", "cert.p12"]) expect(skillFilePathProblem(path), path).toBe("secret_name");
  });

  it("keeps text only, under the size cap, and refuses a file holding a credential", () => {
    expect(skillFileText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBeNull();
    expect(skillFileText(new TextEncoder().encode(SCRIPT))).toBe(SCRIPT);
    expect(skillFileProblem("scripts/report.py", SCRIPT)).toBeNull();
    expect(skillFileProblem("logo.png", new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe("binary");
    expect(skillFileProblem("big.txt", "x".repeat(SKILL_FILE_LIMITS.fileBytes + 1))).toBe("large");
    expect(skillFileProblem("scripts/call.sh", `curl -H "x-api-key: ${KEY}" https://api.example.test`)).toBe("secret");
    expect(skillFileProblem("deploy.sh", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n")).toBe("secret");
  });

  it("admits shallow files first within the per-skill file and byte caps", () => {
    const many = Array.from({ length: SKILL_FILE_LIMITS.files + 3 }, (_, index) => ({ path: `deep/f${String(index).padStart(2, "0")}.txt`, content: "x" }));
    const admitted = admitSkillFiles([{ path: "z.txt", content: "top" }, ...many, { path: "Z.TXT", content: "dup" }, { path: ".env", content: "A=1" }]);
    expect(admitted.files[0]).toEqual({ path: "Z.TXT", content: "dup" });
    expect(admitted.files).toHaveLength(SKILL_FILE_LIMITS.files);
    expect(admitted.refused).toContainEqual({ path: "z.txt", reason: "duplicate" });
    expect(admitted.refused).toContainEqual({ path: ".env", reason: "hidden" });
    expect(admitted.refused.filter((one) => one.reason === "full")).toHaveLength(4);
    const heavy = Array.from({ length: 5 }, (_, index) => ({ path: `h${index}.txt`, content: "y".repeat(SKILL_FILE_LIMITS.fileBytes) }));
    expect(admitSkillFiles(heavy).files).toHaveLength(SKILL_FILE_LIMITS.bytes / SKILL_FILE_LIMITS.fileBytes);
  });

  it("the package gate refuses a skill file that breaks a rule, and never rewrites a script's code as a secret", () => {
    const ok = parsePackageDocument(withFiles([{ path: "scripts/report.py", content: SCRIPT }]), { trust: "file" });
    expect(ok.package.skills!.entries[0]!.files).toEqual([{ path: "scripts/report.py", content: SCRIPT }]);
    expect(packageSecretFindings(ok)).toEqual([]);
    expect(redactPackageSecrets(ok).document.package.skills!.entries[0]!.files![0]!.content).toBe(SCRIPT);
    for (const files of [[{ path: ".env", content: "A=1" }], [{ path: "x.pem", content: "x" }], [{ path: "call.sh", content: KEY }], [{ path: "../up.sh", content: "x" }]]) {
      expect(() => parsePackageDocument(withFiles(files), { trust: "file" }), JSON.stringify(files)).toThrow(PackageFormatError);
    }
  });

  it("a folder carries them as skills/<name>/<path>, names them in skillFiles and reads them back", () => {
    const document = parsePackageDocument(withFiles([{ path: "scripts/report.py", content: SCRIPT }, { path: "references/style.md", content: "# Style\n" }]), { trust: "file" });
    const files = writeShareFolder(document, "bot");
    expect(Object.keys(files).sort()).toEqual(["bot.md", "skills/report/SKILL.md", "skills/report/references/style.md", "skills/report/scripts/report.py"]);
    expect(String(files["bot.md"])).toMatch(/\nskillFiles:\n {2}report:\n/);
    expect(namedFolderFiles(String(files["bot.md"])).sort()).toEqual(["skills/report/SKILL.md", "skills/report/references/style.md", "skills/report/scripts/report.py"]);
    const back = readShareFolder({ ...files, "skills/report/scripts/unlisted.sh": "echo hi" });
    if (back.kind !== "package") throw new Error("not a package");
    expect(canonicalJson(back.document)).toBe(canonicalJson(document));
    const { "skills/report/scripts/report.py": _gone, ...without } = files;
    expect(() => readShareFolder(without)).toThrow(/scripts\/report\.py, but the file is missing/);
    expect(() => readShareFolder({ ...files, "skills/report/scripts/report.py": `token=${KEY}` })).toThrow(PackageFormatError);
    expect(() => readShareFolder({ ...files, "skills/report/scripts/report.py": new Uint8Array([0xff, 0xfe, 0x00, 0x01]) })).toThrow(/isn't a text file/);
  });

  it("files a manifest doesn't name are dropped before the folder's caps count them", () => {
    const document = parsePackageDocument(withFiles([{ path: "run.sh", content: "echo hi\n" }]), { trust: "file" });
    const files = writeShareFolder(document, "bot");
    const clutter = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`skills/report/cache/f${index}.txt`, "x".repeat(20_000)]));
    const kept = normalizeShareFolder({ ...files, ...clutter });
    expect(Object.keys(kept).sort()).toEqual(["bot.md", "skills/report/SKILL.md", "skills/report/run.sh"]);
    expect(readShareFolder({ ...files, ...clutter }).kind).toBe("package");
  });

  it("an older reader's folder (no skillFiles) still reads, and one naming a file outside the skill opens nothing", () => {
    const document = parsePackageDocument(withFiles([{ path: "run.sh", content: "echo hi\n" }]), { trust: "file" });
    const files = writeShareFolder(document, "bot");
    const bare = String(files["bot.md"]).replace(/skillFiles:\n {2}report:\n\s*- run\.sh\n/, "");
    expect(bare).not.toContain("skillFiles");
    const back = readShareFolder({ ...files, "bot.md": bare });
    if (back.kind !== "package") throw new Error("not a package");
    expect(back.document.package.skills!.entries[0]!.files).toBeUndefined();
    const sneaky = String(files["bot.md"]).replace("- run.sh", "- ../../memory/notes.md");
    expect(namedFolderFiles(sneaky)).not.toContain("skills/report/../../memory/notes.md");
  });
});
