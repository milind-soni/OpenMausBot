import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseTeamManifest } from "./team-manifest.ts";
import { scoutProject, suggestTeam, type ProjectProfile } from "./project-scout.ts";

let dirs: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-scout-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("scoutProject", () => {
  it("names the project from the README and summarizes its first paragraph", () => {
    const dir = project({
      "README.md": "[![ci](x)](y)\n# Maus Tracker\n\nTracks every maus in the house.\n\nMore prose.",
      "package.json": JSON.stringify({ name: "not-this", description: "not this either" }),
    });
    const profile = scoutProject(dir);
    expect(profile.name).toBe("Maus Tracker");
    expect(profile.summary).toBe("Tracks every maus in the house.");
  });

  it("falls back to package name, then folder name", () => {
    const fromPkg = scoutProject(project({ "package.json": JSON.stringify({ name: "pkg-name" }) }));
    expect(fromPkg.name).toBe("pkg-name");
    const bare = project({});
    expect(scoutProject(bare).name).toBe(basename(bare));
  });

  it("detects roles from dependencies and folders, with evidence", () => {
    const dir = project({
      "package.json": JSON.stringify({
        dependencies: { react: "^19", express: "^5" },
        devDependencies: { vitest: "^3", typescript: "^5" },
      }),
      "tsconfig.json": "{}",
      "Dockerfile": "FROM node",
      "docs/guide.md": "# Guide",
      "server/index.ts": "",
    });
    const profile = scoutProject(dir);
    const roles = profile.signals.map((signal) => signal.role);
    expect(roles).toEqual(["frontend", "backend", "testing", "infra", "docs"]);
    const backend = profile.signals.find((signal) => signal.role === "backend")!;
    expect(backend.evidence).toContain("express");
    expect(backend.evidence).toContain("server/");
    expect(profile.stacks).toEqual(expect.arrayContaining(["TypeScript", "React", "Node", "Docker"]));
  });

  it("does not call an empty docs folder a docs project", () => {
    const dir = project({ "docs/image.png": "" });
    expect(scoutProject(dir).signals.find((signal) => signal.role === "docs")).toBeUndefined();
  });

  it("reads python projects without a package.json", () => {
    const dir = project({
      "requirements.txt": "fastapi==0.116\npytest==8.0",
      "pyproject.toml": "[project]\nname='svc'",
    });
    const profile = scoutProject(dir);
    expect(profile.signals.map((signal) => signal.role)).toEqual(["backend", "testing"]);
    expect(profile.stacks).toContain("Python");
  });

  it("survives an unreadable folder and malformed files", () => {
    const dir = project({ "package.json": "{not json" });
    expect(scoutProject(dir).signals).toEqual([]);
    expect(scoutProject(join(dir, "does-not-exist")).stacks).toEqual([]);
  });
});

describe("suggestTeam", () => {
  const profile: ProjectProfile = {
    name: "Maus Tracker",
    summary: "Tracks every maus in the house.",
    stacks: ["TypeScript", "React"],
    signals: [
      { role: "frontend", evidence: ["react", "vite"] },
      { role: "testing", evidence: ["vitest"] },
    ],
  };

  it("always leads with a lead, then one member per signal, each with a reason", () => {
    const suggestion = suggestTeam(profile);
    expect(suggestion.roomName).toBe("Maus Tracker");
    expect(suggestion.manifest.team.members.map((member) => member.key)).toEqual(["lead", "frontend", "testing"]);
    expect(suggestion.reasons.frontend).toContain("react");
    expect(suggestion.manifest.team.description).toBe(profile.summary);
    const frontend = suggestion.manifest.team.members[1]!;
    expect(frontend.description).toContain("Maus Tracker");
    expect(frontend.description).toContain("react, vite");
  });

  it("adds a generalist when nothing was detected", () => {
    const suggestion = suggestTeam({ name: "Mystery", summary: "", stacks: [], signals: [] });
    expect(suggestion.manifest.team.members.map((member) => member.key)).toEqual(["lead", "builder"]);
  });

  it("caps the lineup at a lead plus five specialists", () => {
    const wide: ProjectProfile = {
      ...profile,
      signals: (["frontend", "backend", "mobile", "data", "testing", "infra", "docs"] as const).map((role) => ({
        role,
        evidence: ["x"],
      })),
    };
    expect(suggestTeam(wide).manifest.team.members).toHaveLength(6);
  });

  it("emits a manifest the importer accepts verbatim", () => {
    const suggestion = suggestTeam(profile);
    // the round-trip through the real parser is the contract: a suggestion
    // is exactly as importable as a shared team file
    expect(() => parseTeamManifest(JSON.parse(JSON.stringify(suggestion.manifest)))).not.toThrow();
  });
});
