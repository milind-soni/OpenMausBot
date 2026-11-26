import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalJson, parsePackageDocument, PackageFormatError, type PackageDocument } from "./package-format.ts";
import { namedFolderFiles, normalizeShareFolder, readShareFolder, safeFolderPath, writeShareFolder } from "./share-folder.ts";

const FIXTURES = join(import.meta.dirname, "package-fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const fullTeam = () => parsePackageDocument(JSON.parse(fixture("full-team.v2.json")));
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} steps.\n---\n\n# ${name}\n`;

function oneBot(): PackageDocument {
  return parsePackageDocument({
    format: "openmaus.package", version: 2,
    package: {
      id: "helper", release: "1.0.0", name: "Helper", tagline: "Answers questions.", summary: "A helpful bot.", category: "Community",
      author: { name: "MausBot user" }, license: "Unspecified", outcomes: ["Answers."], setupMinutes: 2,
      requirements: { apps: [{ slug: "gmail", label: "Gmail", reason: "Reads mail.", optional: true }], capabilities: [] },
      team: { name: "Helper" },
      agents: [{ key: "helper", name: "Helper", soul: "Be brief.\n---\nNever guess.", appearance: { color: "blue" }, skills: ["triage"], tools: { off: ["images", "warp-drive"] } }],
      routines: [{ key: "daily", name: "Daily", agent: "helper", prompt: "Check.", runOn: "maus", schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, enabledAfterInstall: false }],
      skills: { version: 1, entries: [{ name: "triage", description: "triage steps.", instructions: skill("triage") }] },
    },
  });
}

describe("template folders", () => {
  it("writes a department and reads back the same package, pictures and skills in files", () => {
    const document = fullTeam();
    const files = writeShareFolder(document, "department");
    expect(Object.keys(files).sort()).toEqual(["avatars/lead.png", "skills/objection-handling/SKILL.md", "skills/pricing-policy/SKILL.md",
      "skills/research-brief/SKILL.md", "team.md"]);
    const manifest = String(files["team.md"]);
    expect(manifest).toMatch(/^---\nbotmrr: 2\n/);
    expect(manifest).not.toContain("base64");
    for (const heading of ["Activation", "Mission", "Outcomes", "Connections", "Team", "Chief of Staff", "Completion rule"]) expect(manifest).toContain(`## ${heading}`);
    const back = readShareFolder(files);
    expect(back.kind).toBe("package");
    if (back.kind !== "package") return;
    expect(back.scope).toBe("department");
    expect(canonicalJson(back.document)).toBe(canonicalJson(document));
  });

  it("writes one bot as bot.md, keeps a soul with a --- line, and drops tool groups it doesn't know", () => {
    const document = oneBot();
    expect(document.package.agents[0]!.tools).toEqual({ off: ["images"] });
    const files = writeShareFolder(document, "bot");
    expect(Object.keys(files).sort()).toEqual(["bot.md", "skills/triage/SKILL.md"]);
    const back = readShareFolder(files);
    if (back.kind !== "package") throw new Error("not a package");
    expect(back.scope).toBe("bot");
    expect(back.document.package.agents[0]!.soul).toBe("Be brief.\n---\nNever guess.");
    expect(canonicalJson(back.document)).toBe(canonicalJson(document));
  });

  it("reads the older shapes: BotMRR v1 in team.md or botmrr.md, a team file and a package JSON", () => {
    const legacy = fixture("legacy-botmrr.v1.md");
    for (const name of ["team.md", "botmrr.md"]) expect(readShareFolder({ [name]: legacy }).kind).toBe("package");
    const manifest = readShareFolder({ "team.mausteam.json": fixture("manifest.json") });
    expect(manifest.kind).toBe("manifest");
    const json = readShareFolder({ "sales-desk-1.3.0.openmaus.json": fixture("full-team.v2.json") });
    expect(json.kind === "package" && json.document.package.id).toBe("sales-desk");
  });

  it("looks through one top folder, as a browser's folder upload sends it", () => {
    const files = Object.fromEntries(Object.entries(writeShareFolder(oneBot(), "bot")).map(([path, value]) => [`helper/${path}`, value]));
    expect(readShareFolder({ ...files, "helper/notes.txt": "ignored" }).kind).toBe("package");
  });

  it("refuses unsafe paths and opens only the files a template has", () => {
    for (const path of ["../bot.md", "/etc/passwd", "skills\\x\\SKILL.md", ".hidden/bot.md", "a/../bot.md", "a//b"]) expect(safeFolderPath(path)).toBeNull();
    const kept = normalizeShareFolder({ "bot.md": "x", "../team.md": "y", "skills/a/SKILL.md": "z", "skills/a/run.sh": "rm -rf", "skills/a/.env": "KEY=1",
      "skills/a/node_modules/x.js": "x", "avatars/a.svg": "<svg/>", "memory/notes.md": "secret" });
    expect(Object.keys(kept).sort()).toEqual(["bot.md", "skills/a/SKILL.md"]);
  });

  it("refuses a folder too large or with too many files before parsing it", () => {
    expect(() => normalizeShareFolder({ "bot.md": "x".repeat(6 * 1024 * 1024) })).toThrow(/larger than 4 MB/);
    const many = Object.fromEntries(Array.from({ length: 301 }, (_, index) => [`skills/s${index}/SKILL.md`, "x"]));
    expect(() => normalizeShareFolder(many)).toThrow(/too many files/);
  });

  it("refuses a manifest whose skills or pictures are missing, misnamed or not what they claim", () => {
    const files = writeShareFolder(oneBot(), "bot");
    expect(() => readShareFolder({ "bot.md": files["bot.md"]! })).toThrow(/skills\/triage\/SKILL.md is missing/);
    expect(() => readShareFolder({ ...files, "skills/triage/SKILL.md": skill("other") })).toThrow(/named other inside/);
    const team = writeShareFolder(fullTeam(), "department");
    expect(() => readShareFolder({ ...team, "avatars/lead.png": new TextEncoder().encode("<svg onload=alert(1)>") })).toThrow(PackageFormatError);
    expect(() => readShareFolder({ ...team, "avatars/lead.png": new Uint8Array(70 * 1024) })).toThrow(/larger than 64 KB/);
  });

  it("reads a folder that leaves out its id, release or department name, as its format allows", () => {
    const manifest = ["---", "botmrr: 2", "name: Clip Crew", "tagline: Turn recordings into clips.", "summary: Clips.", "category: Creative",
      "author:", "  name: Someone", "license: MIT", "outcomes:", "  - Clips", "setupMinutes: 5", "requirements:", "  apps: []", "  capabilities: []",
      "team:", "  leader: lead", "agents:", "  - key: lead", "    name: Lead", "    appearance:", "      color: red",
      "routines:", "  - key: daily", "    name: Daily", "    agent: lead", "    prompt: Go", "    runOn: maus", "    durationMinutes: 15",
      "    enabledAfterInstall: false", "    schedule:", "      type: daily", "      time: \"09:00\"", "      weekdays: [mon, 7]", "---", "", "Body."].join("\n");
    const folder = readShareFolder({ "team.md": manifest }, "clip-crew");
    if (folder.kind !== "package") throw new Error("expected a package");
    expect(folder.document.package).toMatchObject({ id: "clip-crew", release: "1.0.0", team: { name: "Clip Crew", leader: "lead" } });
    expect(folder.document.package.routines?.[0]?.schedule).toMatchObject({ type: "daily", weekdays: [1, 0] });
    expect(() => readShareFolder({ "team.md": manifest })).toThrow("package.id");
  });

  it("refuses two manifests, no manifest and a newer version", () => {
    const files = writeShareFolder(oneBot(), "bot");
    expect(() => readShareFolder({ ...files, "team.md": files["bot.md"]! })).toThrow(/not both/);
    expect(() => readShareFolder({ "README.md": "# hi" })).toThrow(/no bot.md or team.md/);
    expect(() => readShareFolder({ "bot.md": String(files["bot.md"]).replace("botmrr: 2", "botmrr: 3") })).toThrow(/newer MausBot/);
  });

  it("names only skills and pictures for a remote reader to fetch", () => {
    const team = writeShareFolder(fullTeam(), "department");
    expect(namedFolderFiles(String(team["team.md"])).sort()).toEqual(["avatars/lead.png", "skills/objection-handling/SKILL.md", "skills/pricing-policy/SKILL.md", "skills/research-brief/SKILL.md"]);
    expect(namedFolderFiles("---\nbotmrr: 2\nskills: [\"../../etc\"]\nagents:\n  - appearance: { avatar: \"../x.png\" }\n---\n")).toEqual([]);
  });
});
