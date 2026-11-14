import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import {
  parseTeamManifest,
  TEAM_MANIFEST_FORMAT,
  TEAM_MANIFEST_VERSION,
  type TeamManifestMember,
  type TeamManifestV2,
} from "./team-manifest.ts";
import type { MausColor } from "./store.ts";

export type ScoutRole =
  | "frontend"
  | "backend"
  | "mobile"
  | "data"
  | "testing"
  | "infra"
  | "docs";

export interface ProjectSignal {
  role: ScoutRole;
  /** Shown to the reviewer and quoted into the member's description, which reaches the provider. */
  evidence: string[];
}

export interface ProjectProfile {
  name: string;
  summary: string;
  stacks: string[];
  signals: ProjectSignal[];
}

export interface TeamSuggestion {
  roomName: string;
  manifest: TeamManifestV2;
  reasons: Record<string, string>;
}

// Read-only and bounded: well-known files by name and top-level listings, nothing recursive.
const MAX_FILE_BYTES = 256_000;
const MAX_DIR_ENTRIES = 400;

function readText(path: string): string | null {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir).slice(0, MAX_DIR_ENTRIES);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function packageJson(cwd: string): { name?: string; description?: string; deps: Set<string> } {
  const raw = readText(join(cwd, "package.json"));
  if (!raw) return { deps: new Set() };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { deps: new Set() };
    const pkg = parsed as Record<string, unknown>;
    const deps = new Set<string>();
    for (const field of ["dependencies", "devDependencies"]) {
      const block = pkg[field];
      if (block && typeof block === "object" && !Array.isArray(block)) {
        for (const dep of Object.keys(block)) deps.add(dep);
      }
    }
    return {
      name: typeof pkg.name === "string" ? pkg.name : undefined,
      description: typeof pkg.description === "string" ? pkg.description : undefined,
      deps,
    };
  } catch {
    return { deps: new Set() };
  }
}

function readme(cwd: string): { title?: string; summary?: string } {
  const raw =
    readText(join(cwd, "README.md")) ?? readText(join(cwd, "readme.md")) ?? readText(join(cwd, "README"));
  if (!raw) return {};
  let title: string | undefined;
  let summary: string | undefined;
  for (const line of raw.slice(0, 64_000).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      if (!title) title = trimmed.replace(/^#+\s*/, "").trim() || undefined;
      continue;
    }
    if (trimmed.startsWith("[![") || trimmed.startsWith("![") || trimmed.startsWith("<") || trimmed.startsWith(">")) continue;
    summary = trimmed.replace(/[*_`]/g, "").slice(0, 1_000);
    break;
  }
  return { title, summary };
}

interface Detector {
  role: ScoutRole;
  deps: string[];
  paths: string[];
}

// Order is priority: when a suggestion is trimmed, earlier roles survive.
const DETECTORS: Detector[] = [
  {
    role: "frontend",
    deps: ["react", "vue", "svelte", "next", "nuxt", "astro", "vite", "@angular/core", "solid-js"],
    paths: ["index.html", "vite.config.ts", "vite.config.js", "next.config.js", "next.config.ts"],
  },
  {
    role: "backend",
    deps: ["express", "fastify", "koa", "hono", "@nestjs/core", "django", "flask", "fastapi"],
    paths: ["server", "api", "go.mod"],
  },
  {
    role: "mobile",
    deps: ["react-native", "expo"],
    paths: ["ios", "android", "pubspec.yaml"],
  },
  {
    role: "data",
    deps: ["prisma", "drizzle-orm", "knex", "sequelize", "typeorm", "mongoose", "pg", "mysql2", "better-sqlite3", "sqlalchemy"],
    paths: ["prisma", "migrations"],
  },
  {
    role: "testing",
    deps: ["vitest", "jest", "mocha", "@playwright/test", "cypress", "pytest"],
    paths: ["test", "tests", "__tests__", "e2e"],
  },
  {
    role: "infra",
    deps: [],
    paths: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml", ".github/workflows", "terraform", "helm"],
  },
  {
    role: "docs",
    deps: [],
    paths: ["docs", "mkdocs.yml"],
  },
];

const STACK_MARKERS: Array<{ stack: string; deps?: string[]; paths?: string[] }> = [
  { stack: "TypeScript", deps: ["typescript"], paths: ["tsconfig.json"] },
  { stack: "React", deps: ["react"] },
  { stack: "Vue", deps: ["vue"] },
  { stack: "Svelte", deps: ["svelte"] },
  { stack: "Next.js", deps: ["next"] },
  { stack: "Vite", deps: ["vite"] },
  { stack: "Node", paths: ["package.json"] },
  { stack: "Python", paths: ["pyproject.toml", "requirements.txt", "setup.py"] },
  { stack: "Rust", paths: ["Cargo.toml"] },
  { stack: "Go", paths: ["go.mod"] },
  { stack: "Ruby", paths: ["Gemfile"] },
  { stack: "PHP", paths: ["composer.json"] },
  { stack: "Java", paths: ["pom.xml", "build.gradle", "build.gradle.kts"] },
  { stack: "Docker", paths: ["Dockerfile", "docker-compose.yml", "compose.yaml"] },
];

export function scoutProject(cwd: string): ProjectProfile {
  const pkg = packageJson(cwd);
  const md = readme(cwd);
  const entries = new Set(listNames(cwd));

  const pythonDeps = `${readText(join(cwd, "requirements.txt")) ?? ""}\n${readText(join(cwd, "pyproject.toml")) ?? ""}`.toLowerCase();
  const hasDep = (dep: string) => pkg.deps.has(dep) || (pythonDeps.length > 1 && pythonDeps.includes(dep));

  const pathEvidence = (path: string): string | null => {
    if (path.includes("/")) return isDir(join(cwd, path)) && listNames(join(cwd, path)).length > 0 ? `${path}/` : null;
    if (entries.has(path)) return isDir(join(cwd, path)) ? `${path}/` : path;
    return null;
  };

  const signals: ProjectSignal[] = [];
  for (const detector of DETECTORS) {
    const evidence: string[] = [];
    for (const dep of detector.deps) if (hasDep(dep)) evidence.push(dep);
    for (const path of detector.paths) {
      const found = pathEvidence(path);
      if (found) evidence.push(found);
    }
    if (detector.role === "docs" && evidence.length > 0) {
      const hasMkdocs = evidence.includes("mkdocs.yml");
      const hasMarkdown = listNames(join(cwd, "docs")).some((name) => name.endsWith(".md"));
      if (!hasMkdocs && !hasMarkdown) continue;
    }
    if (evidence.length > 0) signals.push({ role: detector.role, evidence: evidence.slice(0, 6) });
  }

  const stacks: string[] = [];
  for (const marker of STACK_MARKERS) {
    const byDep = marker.deps?.some((dep) => hasDep(dep)) ?? false;
    const byPath = marker.paths?.some((path) => entries.has(path)) ?? false;
    if (byDep || byPath) stacks.push(marker.stack);
  }

  return {
    name: (md.title ?? pkg.name ?? basename(cwd)).slice(0, 100),
    summary: (md.summary ?? pkg.description ?? "").slice(0, 1_000),
    stacks,
    signals,
  };
}

interface RoleTemplate {
  name: string;
  title: string;
  color: MausColor;
  describe: (profile: ProjectProfile, evidence: string[]) => string;
}

const stackLine = (profile: ProjectProfile) =>
  profile.stacks.length > 0 ? ` The stack: ${profile.stacks.join(", ")}.` : "";

const ROLE_TEMPLATES: Record<ScoutRole, RoleTemplate> = {
  frontend: {
    name: "Pixel",
    title: "Frontend Builder",
    color: "pink",
    describe: (profile, evidence) =>
      `You build and refine the user interface of ${profile.name}.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. Keep changes small, match the existing component patterns, and check what you built actually renders before calling it done.`,
  },
  backend: {
    name: "Forge",
    title: "Backend Builder",
    color: "blue",
    describe: (profile, evidence) =>
      `You own the server side of ${profile.name}: endpoints, business logic, and the contracts the frontend relies on.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. Change behavior only alongside the tests that prove it.`,
  },
  mobile: {
    name: "Pocket",
    title: "Mobile Builder",
    color: "coral",
    describe: (profile, evidence) =>
      `You keep ${profile.name} working on phones: screens, navigation, and platform quirks.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. Test on both platforms before declaring victory.`,
  },
  data: {
    name: "Schema",
    title: "Data Engineer",
    color: "teal",
    describe: (profile, evidence) =>
      `You own the data layer of ${profile.name}: models, migrations, and query performance.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. Every migration ships with its rollback story.`,
  },
  testing: {
    name: "Probe",
    title: "Test Engineer",
    color: "green",
    describe: (profile, evidence) =>
      `You guard ${profile.name} with tests: you reproduce bugs before they are fixed and extend coverage where changes land.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. A red test you wrote is worth more than a green suite nobody trusts.`,
  },
  infra: {
    name: "Anchor",
    title: "Infra & CI",
    color: "orange",
    describe: (profile, evidence) =>
      `You keep ${profile.name} buildable, shippable, and observable: CI, containers, and deploy paths.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. Prefer boring, reproducible steps over clever ones.`,
  },
  docs: {
    name: "Quill",
    title: "Docs Writer",
    color: "purple",
    describe: (profile, evidence) =>
      `You keep the documentation of ${profile.name} truthful and current.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. When code and docs disagree, you chase down which one is lying.`,
  },
};

const LEAD: RoleTemplate = {
  name: "Compass",
  title: "Project Lead",
  color: "yellow",
  describe: (profile) =>
    `You coordinate work on ${profile.name}: break briefs into tasks for the team, keep the room's bulletin current, and review results before they count as done.${stackLine(profile)}${profile.summary ? ` The project, in its own words: ${profile.summary}` : ""}`,
};

const MAX_SUGGESTED_SPECIALISTS = 5;

export function suggestTeam(profile: ProjectProfile): TeamSuggestion {
  const reasons: Record<string, string> = {
    lead: "Every project room needs one member who briefs, splits, and reviews.",
  };
  const members: TeamManifestMember[] = [
    {
      key: "lead",
      name: LEAD.name,
      title: LEAD.title,
      description: LEAD.describe(profile, []),
      appearance: { color: LEAD.color },
    },
  ];
  for (const signal of profile.signals.slice(0, MAX_SUGGESTED_SPECIALISTS)) {
    const template = ROLE_TEMPLATES[signal.role];
    members.push({
      key: signal.role,
      name: template.name,
      title: template.title,
      description: template.describe(profile, signal.evidence),
      appearance: { color: template.color },
    });
    reasons[signal.role] = `Detected via ${signal.evidence.join(", ")}.`;
  }
  if (members.length === 1) {
    members.push({
      key: "builder",
      name: "Wrench",
      title: "Builder",
      description: `You do the hands-on work in ${profile.name}: read the folder, make the change, show the result.${stackLine(profile)}`,
      appearance: { color: "blue" },
    });
    reasons.builder = "No specific stack detected — a generalist covers the ground.";
  }

  const manifest: TeamManifestV2 = {
    format: TEAM_MANIFEST_FORMAT,
    version: TEAM_MANIFEST_VERSION,
    team: {
      name: `${profile.name} team`.slice(0, 100),
      members,
    },
  };
  if (profile.summary) manifest.team.description = profile.summary.slice(0, 2_000);

  // Same parser as import, so a suggestion is exactly as valid as a shared file.
  return { roomName: profile.name, manifest: parseTeamManifest(manifest), reasons };
}
