import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";
import { mentionedProjects, readRegisteredProjects, resolveProjectContext, type RegisteredProject } from "./projects.ts";
import { applySuggestedFolder } from "../src/lib/projectSuggestions.ts";

const roots: string[] = [];
afterEach(() => {
  delete process.env.GBS_PROJECTS_FILE;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gbs-project-context-"));
  roots.push(root);
  const availablePath = join(root, "Available");
  mkdirSync(availablePath);
  const projects: RegisteredProject[] = [
    { id: "one", name: "Available", mention: "available", path: availablePath, available: true },
    { id: "two", name: "Missing", mention: "missing", path: join(root, "Missing"), available: false },
  ];
  return { root, availablePath, projects };
}

describe("readRegisteredProjects", () => {
  it("reads the explicit test registry and checks folders", () => {
    const { root, availablePath, projects } = fixture();
    const filePath = join(root, "projects.json");
    writeFileSync(filePath, JSON.stringify(projects.map(({ available: _available, ...project }) => project)));
    process.env.GBS_PROJECTS_FILE = filePath;

    expect(readRegisteredProjects()).toEqual(projects);
    expect(readRegisteredProjects()[0].path).toBe(availablePath);
  });

  it("rejects malformed records, relative paths, and duplicate handles", () => {
    const { root } = fixture();
    const filePath = join(root, "projects.json");
    writeFileSync(filePath, JSON.stringify([
      { id: "a", name: "A", mention: "same", path: "relative" },
      { id: "b", name: "B", mention: "same", path: "/tmp/b" },
    ]));
    expect(readRegisteredProjects([filePath])).toEqual([]);
  });
});

describe("mentionedProjects", () => {
  it("uses exact, case-insensitive boundaries and deduplicates", () => {
    const { projects } = fixture();
    expect(mentionedProjects("#AVAILABLE, #missing #available", projects).map((project) => project.id)).toEqual(["one", "two"]);
    expect(mentionedProjects("mail#available #general #available-extra", projects)).toEqual([]);
  });
});

describe("resolveProjectContext", () => {
  it("uses the first source with known references and selects one available cwd", () => {
    const { availablePath, projects } = fixture();
    const context = resolveProjectContext(["latest #available", "default #missing"], projects);
    expect(context.cwd).toBe(availablePath);
    expect(context.projects.map((project) => project.id)).toEqual(["one"]);
    expect(context.system).toContain(`#available (Available): ${availablePath}`);
  });

  it("falls back past unknown hashtags but not known missing projects", () => {
    const { projects } = fixture();
    expect(resolveProjectContext(["#general", "use #available"], projects).projects[0].id).toBe("one");
    const missing = resolveProjectContext(["use #missing", "use #available"], projects);
    expect(missing.cwd).toBeUndefined();
    expect(missing.system).toContain("registered folder is missing");
  });

  it("does not choose a cwd for multiple references", () => {
    const { projects } = fixture();
    const context = resolveProjectContext(["compare #available and #missing"], projects);
    expect(context.cwd).toBeUndefined();
    expect(context.projects).toHaveLength(2);
  });
});

const posixOnly = describe.skipIf(process.platform === "win32");
const serverDirectory = dirname(fileURLToPath(import.meta.url));
const fakeCli = join(serverDirectory, "testing", "fake-acp-cli.ts");

posixOnly("project context turn integration", () => {
  const port = 28_000 + Math.floor(Math.random() * 10_000);
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess;
  let home: string;
  let workspace: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };

  beforeAll(async () => {
    chmodSync(fakeCli, 0o755);
    home = mkdtempSync(join(tmpdir(), "gbs-project-turn-"));
    workspace = join(home, "Trusted Workspace");
    mkdirSync(workspace);
    const configDirectory = join(home, ".gbs");
    mkdirSync(configDirectory);
    writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
      instances: {
        grok: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "echo-context" },
          config: { cli: fakeCli, fullAuto: true },
        },
      },
    }));
    const projectsFile = join(home, "projects.json");
    writeFileSync(projectsFile, JSON.stringify([
      { id: "trusted", name: "Trusted Workspace", mention: "trusted", path: workspace, source: "existing", addedAt: 1 },
    ]));

    child = spawn(process.execPath, [join(serverDirectory, "index.ts")], {
      cwd: join(serverDirectory, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        GBS_PORT: String(port),
        GBS_PROJECTS_FILE: projectsFile,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        // Server is still starting.
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("passes only the registered project into the turn prompt and cwd", async () => {
    const seeded = (await api("GET", "/api/bots")).body.bots[0];
    await api("PATCH", `/api/bots/${seeded.id}`, {
      modelSelection: { instanceId: "grok", model: "fake-model" },
      description: "Default to #trusted",
    });
    expect((await api("POST", `/api/bots/${seeded.id}/messages`, {
      text: "Work in #trusted and ignore /tmp/not-a-project",
    })).status).toBe(202);

    const deadline = Date.now() + 15_000;
    let bot: any;
    for (;;) {
      bot = (await api("GET", "/api/bots")).body.bots.find((candidate: any) => candidate.id === seeded.id);
      if (!bot.busy && bot.messages.some((message: any) => message.role === "bot" && message.kind === "text")) break;
      if (Date.now() > deadline) throw new Error(`turn did not settle. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const reply = bot.messages.findLast((message: any) => message.role === "bot" && message.kind === "text");
    const context = JSON.parse(reply.text);
    expect(context.cwd).toBe(workspace);
    expect(context.prompt).toContain(`#trusted (Trusted Workspace): ${workspace}`);
    expect(context.prompt).toContain("Use only these canonical paths");
  }, 20_000);

  it("accepts chip-generated ~/ paths on /api/projects/* and rejects traversal or symlink escapes", async () => {
    const projectsDir = join(home, "Projects");
    mkdirSync(projectsDir, { recursive: true });
    const canonicalProjectsDir = realpathSync(projectsDir);

    const outside = mkdtempSync(join(tmpdir(), "gbs-outside-home-"));
    roots.push(outside);
    symlinkSync(outside, join(home, "escape-link"), "dir");

    const addChipPath = applySuggestedFolder("~/Projects", { mode: "existing" });
    const added = await api("POST", "/api/projects/add-existing", { projectPath: addChipPath });
    expect(added.status).toBe(201);
    expect(added.body.project).toMatchObject({
      name: "Projects",
      path: canonicalProjectsDir,
      source: "existing",
    });

    const createChipParent = applySuggestedFolder("~/Projects", { mode: "create" });
    const created = await api("POST", "/api/projects/create", {
      parentPath: createChipParent,
      name: "qa-chip-folder",
    });
    expect(created.status).toBe(201);
    expect(created.body.project).toMatchObject({
      name: "qa-chip-folder",
      path: join(canonicalProjectsDir, "qa-chip-folder"),
      source: "created",
    });

    const cloneChipDest = applySuggestedFolder("~/Projects", {
      mode: "clone",
      repositoryUrl: "https://github.com/example/qa-chip-folder",
    });
    const cloneExistingCheck = await api("POST", "/api/projects/clone", {
      repositoryUrl: "https://github.com/example/qa-chip-folder",
      destinationPath: cloneChipDest,
    });
    expect(cloneExistingCheck.status).toBe(400);
    expect(cloneExistingCheck.body.error).toContain("clone destination already exists");

    for (const badPath of ["~/../outside", "~/escape-link"]) {
      const badAdd = await api("POST", "/api/projects/add-existing", { projectPath: badPath });
      expect(badAdd.status).toBe(400);
      expect(badAdd.body.error).toContain("inside your home directory");

      const badCreate = await api("POST", "/api/projects/create", {
        parentPath: badPath,
        name: "escaped",
      });
      expect(badCreate.status).toBe(400);
      expect(badCreate.body.error).toContain("inside your home directory");

      const badClone = await api("POST", "/api/projects/clone", {
        repositoryUrl: "https://github.com/example/repo",
        destinationPath: `${badPath}/repo`,
      });
      expect(badClone.status).toBe(400);
      expect(badClone.body.error).toContain("inside your home directory");
    }
  });
});
