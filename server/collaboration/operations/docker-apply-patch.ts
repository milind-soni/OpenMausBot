import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

interface PatchChange {
  path: string;
  contents: string;
}

interface PatchManifest {
  root: string;
  writeScopes: string[];
  changes: PatchChange[];
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function scopePattern(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "u");
}

function parseManifest(path: string): PatchManifest {
  const raw = readFileSync(path);
  if (raw.length < 2 || raw.length > 2 * 1024 * 1024) throw new Error("patch_manifest_size_invalid");
  const value = JSON.parse(raw.toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("patch_manifest_invalid");
  const manifest = value as Partial<PatchManifest>;
  if (typeof manifest.root !== "string" || !Array.isArray(manifest.writeScopes) || !Array.isArray(manifest.changes)) {
    throw new Error("patch_manifest_invalid");
  }
  if (manifest.changes.length < 1 || manifest.changes.length > 64 || manifest.writeScopes.length < 1) {
    throw new Error("patch_manifest_limits_invalid");
  }
  return manifest as PatchManifest;
}

export function applyDockerPatchManifest(path: string): string[] {
  const manifest = parseManifest(path);
  const root = realpathSync(manifest.root);
  const patterns = manifest.writeScopes.map(scopePattern);
  const changed: string[] = [];
  let contentBytes = 0;
  for (const change of manifest.changes) {
    if (!change || typeof change.path !== "string" || typeof change.contents !== "string") {
      throw new Error("patch_change_invalid");
    }
    const relativePath = change.path.replaceAll("\\", "/");
    if (
      !relativePath ||
      isAbsolute(relativePath) ||
      relativePath.includes("\0") ||
      relativePath.split("/").includes("..") ||
      relativePath === ".git" ||
      relativePath.startsWith(".git/") ||
      /(?:^|\/)\.env(?:\.|$)/u.test(relativePath) ||
      !patterns.some((pattern) => pattern.test(relativePath))
    ) {
      throw new Error(`patch_path_denied:${relativePath.slice(0, 200)}`);
    }
    contentBytes += Buffer.byteLength(change.contents, "utf8");
    if (contentBytes > 1024 * 1024) throw new Error("patch_content_limit_exceeded");
    const target = resolve(root, relativePath);
    if (!contained(root, target)) throw new Error("patch_path_escaped");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const parent = realpathSync(dirname(target));
    if (!contained(root, parent)) throw new Error("patch_parent_escaped");
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error("patch_symlink_denied");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writeFileSync(target, change.contents, { mode: 0o600 });
    changed.push(relativePath);
  }
  return changed;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path || !isAbsolute(path)) throw new Error("patch_manifest_path_required");
  const changed = applyDockerPatchManifest(path);
  process.stdout.write(`${JSON.stringify({ status: "applied", changed })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ status: "failed", code: error instanceof Error ? error.message : "patch_failed" })}\n`);
    process.exitCode = 1;
  });
}
