import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECTS_FILE = "projects.json";
const MAX_GIT_ERROR_LENGTH = 8_000;
const PROJECT_MENTION_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

function projectError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "ProjectError";
  return error;
}

function validateRecord(record) {
  if (
    !record ||
    typeof record !== "object" ||
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.path !== "string" ||
    (record.mention !== undefined &&
      (typeof record.mention !== "string" || !PROJECT_MENTION_PATTERN.test(record.mention))) ||
    !["existing", "created", "github"].includes(record.source) ||
    typeof record.addedAt !== "number" ||
    (record.repositoryUrl !== undefined && typeof record.repositoryUrl !== "string")
  ) {
    throw projectError("Saved project data is invalid. The file was left unchanged.");
  }
  return record;
}

export function projectMentionSlug(name) {
  const slug = String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/-+/g, "-");
  return slug || "project";
}

function assignMissingMentions(records) {
  const used = new Set();
  const migratedMentions = new Set();
  for (const record of records) {
    if (record.mention && !used.has(record.mention)) used.add(record.mention);
  }
  let changed = false;
  const migrated = records.map((record) => {
    if (record.mention && used.has(record.mention)) {
      // The first instance keeps a duplicate legacy slug; later instances
      // are assigned a fresh one below.
      if (!migratedMentions.has(record.mention)) {
        migratedMentions.add(record.mention);
        return record;
      }
    }
    const base = projectMentionSlug(record.name);
    let mention = base;
    let suffix = 2;
    while (used.has(mention)) mention = `${base}-${suffix++}`;
    used.add(mention);
    migratedMentions.add(mention);
    changed = true;
    return { ...record, mention };
  });
  return { records: migrated, changed };
}

function validateFolderName(name) {
  const value = String(name ?? "").trim();
  if (!value) throw projectError("Enter a folder name.");
  if (value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw projectError("Folder names cannot contain path separators.");
  }
  if (/[. ]$/.test(value)) throw projectError("Folder names cannot end with a period or space.");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)) {
    throw projectError("That folder name is reserved by the operating system.");
  }
  return value;
}

export function parseGitHubRepositoryUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw projectError("Enter a GitHub repository URL.");

  const ssh = raw.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (ssh) {
    const repository = ssh[2];
    if (!repository) throw projectError("Enter a valid GitHub repository URL.");
    return { repositoryUrl: raw, folderName: repository };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw projectError("Use a GitHub HTTPS or SSH repository URL.");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw projectError("Only github.com HTTPS or SSH repository URLs are supported.");
  }
  if (url.username || url.password) {
    throw projectError("Repository URLs containing credentials are not supported.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw projectError("Enter a repository URL such as https://github.com/owner/repo.");
  const folderName = parts[1].replace(/\.git$/i, "");
  if (!folderName) throw projectError("Enter a valid GitHub repository URL.");
  return {
    repositoryUrl: `https://github.com/${parts[0]}/${folderName}.git`,
    folderName,
  };
}

async function isDirectory(targetPath) {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function canonicalDirectory(targetPath, label = "Folder") {
  const value = String(targetPath ?? "").trim();
  if (!value || !path.isAbsolute(value)) throw projectError(`${label} must be an absolute path.`);
  let canonical;
  try {
    canonical = await realpath(value);
  } catch {
    throw projectError(`${label} does not exist.`);
  }
  if (!(await isDirectory(canonical))) throw projectError(`${label} is not a directory.`);
  return canonical;
}

async function assertWithinAllowedRoot(parent, allowedRoot) {
  if (!allowedRoot) return;
  const root = await canonicalDirectory(allowedRoot, "Allowed project root");
  const relativePath = path.relative(root, parent);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw projectError("Browser projects can only be created or cloned inside your home directory.");
  }
}

function pathKey(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function runGitClone({ repositoryUrl, destinationPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["clone", "--", repositoryUrl, destinationPath], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-MAX_GIT_ERROR_LENGTH);
    });
    child.once("error", (error) => {
      reject(
        projectError(
          error?.code === "ENOENT"
            ? "Git is not installed or is not available on PATH."
            : `Could not start Git: ${error.message}`,
          error,
        ),
      );
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        const detail = stderr.trim().split(/\r?\n/).slice(-4).join("\n");
        reject(
          projectError(
            detail || `Git clone failed${signal ? ` (${signal})` : code === null ? "" : ` with exit code ${code}`}.`,
          ),
        );
      }
    });
  });
}

export class ProjectService {
  constructor({ dataDir, filePath, cloneRepository = runGitClone }) {
    if (!dataDir || !path.isAbsolute(dataDir)) throw projectError("Project data directory must be absolute.");
    this.dataDir = dataDir;
    if (filePath && !path.isAbsolute(filePath)) throw projectError("Project registry path must be absolute.");
    this.filePath = filePath || path.join(dataDir, PROJECTS_FILE);
    this.cloneRepository = cloneRepository;
  }

  async readRecords() {
    let raw;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw projectError("Could not read saved projects.", error);
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("Expected an array");
      const validated = parsed.map(validateRecord);
      const migrated = assignMissingMentions(validated);
      if (migrated.changed) await this.writeRecords(migrated.records);
      return migrated.records;
    } catch (error) {
      if (error?.name === "ProjectError") throw error;
      throw projectError("Saved project data is invalid. The file was left unchanged.", error);
    }
  }

  async writeRecords(records) {
    await mkdir(this.dataDir, { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.filePath);
    } catch (error) {
      throw projectError("Could not save projects.", error);
    }
  }

  async list() {
    const records = await this.readRecords();
    return Promise.all(records.map(async (record) => ({ ...record, missing: !(await isDirectory(record.path)) })));
  }

  async addRecord({ projectPath, source, repositoryUrl }) {
    const canonicalPath = await canonicalDirectory(projectPath, "Project folder");
    const records = await this.readRecords();
    const duplicate = records.find((record) => pathKey(record.path) === pathKey(canonicalPath));
    if (duplicate) return { ...duplicate, missing: false };
    const record = {
      id: randomUUID(),
      name: path.basename(canonicalPath),
      mention: (() => {
        const base = projectMentionSlug(path.basename(canonicalPath));
        const used = new Set(records.map((item) => item.mention));
        let candidate = base;
        let suffix = 2;
        while (used.has(candidate)) candidate = `${base}-${suffix++}`;
        return candidate;
      })(),
      path: canonicalPath,
      source,
      ...(repositoryUrl ? { repositoryUrl } : {}),
      addedAt: Date.now(),
    };
    await this.writeRecords([record, ...records]);
    return { ...record, missing: false };
  }

  async addExisting(projectPath) {
    return this.addRecord({ projectPath, source: "existing" });
  }

  async createProject({ parentPath, name, allowedRoot }) {
    const parent = await canonicalDirectory(parentPath, "Parent folder");
    await assertWithinAllowedRoot(parent, allowedRoot);
    const folderName = validateFolderName(name);
    const projectPath = path.join(parent, folderName);
    try {
      await mkdir(projectPath, { recursive: false });
    } catch (error) {
      if (error?.code === "EEXIST") throw projectError("A file or folder already exists at that path.");
      throw projectError(`Could not create the project folder: ${error.message}`, error);
    }
    return this.addRecord({ projectPath, source: "created" });
  }

  async cloneProject({ repositoryUrl, destinationPath, allowedRoot }) {
    const parsed = parseGitHubRepositoryUrl(repositoryUrl);
    const destination = path.resolve(String(destinationPath ?? "").trim());
    if (!destinationPath || !path.isAbsolute(String(destinationPath))) {
      throw projectError("Clone destination must be an absolute path.");
    }
    const parent = await canonicalDirectory(path.dirname(destination), "Destination parent folder");
    await assertWithinAllowedRoot(parent, allowedRoot);
    const normalizedDestination = path.join(parent, path.basename(destination));
    try {
      await access(normalizedDestination, fsConstants.F_OK);
      throw projectError("The clone destination already exists. Choose an empty path.");
    } catch (error) {
      if (error?.name === "ProjectError") throw error;
      if (error?.code !== "ENOENT") throw projectError("Could not inspect the clone destination.", error);
    }
    await this.cloneRepository({
      repositoryUrl: parsed.repositoryUrl,
      destinationPath: normalizedDestination,
    });
    return this.addRecord({
      projectPath: normalizedDestination,
      source: "github",
      repositoryUrl: parsed.repositoryUrl,
    });
  }

  async assertRegistered(projectPath) {
    const records = await this.readRecords();
    const requestedPath = String(projectPath ?? "");
    let canonicalPath = requestedPath;
    try {
      canonicalPath = await realpath(requestedPath);
    } catch {
      // A missing registered folder is handled below with a more useful error.
    }
    const match = records.find(
      (record) =>
        pathKey(record.path) === pathKey(canonicalPath) || pathKey(record.path) === pathKey(requestedPath),
    );
    if (!match) throw projectError("That project is not registered.");
    if (!(await isDirectory(match.path))) throw projectError("The project folder no longer exists.");
    return match;
  }
}

export function registerProjectsIpc({ ipcMain, dialog, shell, dataDir }) {
  const projects = new ProjectService({ dataDir });
  ipcMain.handle("projects:list", () => projects.list());
  ipcMain.handle("projects:choose-directory", async (_event, options = {}) => {
    const result = await dialog.showOpenDialog({
      title: options.title || "Choose a folder",
      buttonLabel: options.buttonLabel || "Choose",
      defaultPath: options.defaultPath || undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("projects:add-existing", (_event, projectPath) => projects.addExisting(projectPath));
  ipcMain.handle("projects:create", (_event, input) => projects.createProject(input ?? {}));
  ipcMain.handle("projects:clone", (_event, input) => projects.cloneProject(input ?? {}));
  ipcMain.handle("projects:open", async (_event, projectPath) => {
    const project = await projects.assertRegistered(projectPath);
    const message = await shell.openPath(project.path);
    if (message) throw projectError(message);
  });
}
