// Private prerequisite bootstrap. No system package manager, sudo, shell,
// Electron-as-Node trick, or changes to the user's shell configuration.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { NODE_RUNTIME_VERSION, nodeRuntimeRelease } from "./node-runtime-release.ts";

const exec = promisify(execFile);
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const pending = new Map<string, Promise<ManagedNode>>();
export interface ManagedNode { node: string; npmCli: string; bin: string }

function paths(root: string, platform = process.platform): ManagedNode {
  const bin = platform === "win32" ? root : join(root, "bin");
  return {
    bin,
    node: join(bin, platform === "win32" ? "node.exe" : "node"),
    npmCli: join(root, ...(platform === "win32" ? [] : ["lib"]), "node_modules", "npm", "bin", "npm-cli.js"),
  };
}

export function managedNodePaths(baseDir: string): ManagedNode | null {
  const release = nodeRuntimeRelease();
  return release ? paths(join(baseDir, "tools", "node", release.directory)) : null;
}

async function usable(runtime: ManagedNode): Promise<boolean> {
  if (!existsSync(runtime.node) || !existsSync(runtime.npmCli)) return false;
  try {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await exec(runtime.node, ["--version"], { timeout: 10_000, windowsHide: true, env });
    return stdout.trim() === `v${NODE_RUNTIME_VERSION}`;
  } catch { return false; }
}

export function ensureManagedNode(baseDir: string): Promise<ManagedNode> {
  const running = pending.get(baseDir);
  if (running) return running;
  const result = prepare(baseDir).finally(() => pending.delete(baseDir));
  pending.set(baseDir, result);
  return result;
}

async function prepare(baseDir: string): Promise<ManagedNode> {
  const release = nodeRuntimeRelease();
  const runtime = managedNodePaths(baseDir);
  if (!release || !runtime) throw new Error("Automatic prerequisite setup is not supported on this operating system or processor. Use the manual installation instructions.");
  if (await usable(runtime)) return runtime;
  const parent = join(baseDir, "tools", "node");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, ".download-"));
  try {
    const archive = join(staging, release.file);
    await download(`https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${release.file}`, archive, release.sha256);
    // Only verified, pinned archives reach the OS extractor. Modern Windows
    // ships bsdtar; POSIX platforms ship tar. No developer tools required.
    const tar = process.platform === "win32"
      ? win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "/usr/bin/tar";
    try {
      await exec(tar, ["-xf", archive, "-C", staging], { timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 });
    } catch {
      throw new Error("Could not unpack the required tools. Check available disk space and that the operating system's tar utility is available, then retry.");
    }
    const extracted = join(staging, release.directory);
    if (!(await usable(paths(extracted)))) throw new Error("The downloaded tools cannot run on this operating system. Check system compatibility and permissions.");
    const destination = join(parent, release.directory);
    // Another process may have completed while this download was running.
    if (await usable(runtime)) return runtime;
    if (existsSync(destination)) await rename(destination, join(staging, "previous-incomplete-runtime"));
    await rename(extracted, destination);
    return runtime;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function download(url: string, destination: string, digest: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5 * 60_000) });
  } catch {
    throw new Error("Could not download the required tools from nodejs.org. Check your network or proxy connection and retry.");
  }
  if (!response.ok || !response.body) throw new Error(`Could not download the required tools (HTTP ${response.status}). Check your connection and retry.`);
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  const file = await open(destination, "wx", 0o600);
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > MAX_ARCHIVE_BYTES) throw new Error("The required-tools download is too large.");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ARCHIVE_BYTES) throw new Error("The required-tools download is too large.");
      hash.update(value);
      await file.writeFile(value);
    }
    if (hash.digest("hex") !== digest) throw new Error("Required-tools download failed verification. Nothing was installed. Please retry.");
  } finally {
    await reader.cancel().catch(() => {});
    await file.close();
  }
}
