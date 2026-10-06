// Cua Spaces backend for the Local VM (opt-in: `localVm.backend`).
//
// The person installs Cua Spaces (the `cua` CLI and, on macOS, the Cua Spaces
// app that hosts its daemon). Cua owns everything inside the boundary: the
// image, the container or Lume VM, the desktop, cua-spacesd and its viewer.
// OpenMausBot only derives a Space name per Local VM target, drives the
// Space's lifecycle through the CLI, takes preview frames, and hands agents
// `cua mcp` scoped to that one Space. Cua Spaces is source-available
// (FSL-1.1-MIT) and is never bundled — everything here calls the user's CLI.
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir, type NetworkInterfaceInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, posix } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import {
  checkedExecSeconds,
  clipExecOutput,
  runExec,
  wholeScreenshot,
  type ContainerExecResult,
  type ExecRunner,
  type LifecycleAction,
  type LocalVmMcpLaunch,
  type LocalVmTarget,
} from "./container-computer.ts";
import { augmentedPath, resolveCliSpawn } from "./env-path.ts";
import { cuaSpaceOwnership, forgetCuaSpaceOwnership, recordCuaSpaceOwnership } from "./cua-space-ownership.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import type { VmOs } from "../shared/wire.ts";

const run = promisify(execFile);

export const CUA_SPACES_INSTALL_URL = "https://cua.ai/docs/spaces/quickstart";
/** The CLI surface this adapter was written and live-tested against. */
export const MIN_CUA_VERSION = "0.2.0";
/** Pinned catalog refs, not the moving `linux`/`macos` aliases: the macOS
 * alias names the full image (dev tools, another ~27 GB download). The slim
 * image has cua-spacesd, Safari and Chrome, which is what a bot's desktop
 * needs. */
export const SPACE_IMAGES: Record<VmOs, string> = {
  linux: "ghcr.io/trycua/linux:24.04",
  macos: "ghcr.io/trycua/macos:26-slim",
};

const LIST_TTL_MS = 1_500;
const VERSION_TTL_MS = 60_000;
const FRAME_STATUS_TTL_MS = 10_000;
/** A first macOS Space downloads a ~27 GB image before it boots. */
const CREATE_TIMEOUT_MS = 45 * 60_000;
const LIFECYCLE_TIMEOUT_MS = 3 * 60_000;
const STARTING_STATES = new Set(["creating", "starting", "booting", "provisioning", "resuming"]);
const STOPPED_STATES = new Set(["stopped", "suspended", "paused"]);

/** `cua` runner. `cwd` lets a call name a local path relatively: `cua sb cp`
 * reads `NAME:path` from its arguments, so a Windows drive path (`C:\…`)
 * must never appear there. */
export type CuaRunner = (command: string, args: string[], timeout?: number, cwd?: string) => Promise<{ stdout: string }>;

export interface CuaDeps {
  /** Absolute path of the `cua` CLI, or null when it is not installed. */
  cli: string | null;
  run: CuaRunner;
  exec: ExecRunner;
  /** Isolated fixtures may keep ownership outside the application's DATA_DIR. */
  dataDir?: string;
}

export interface CuaHost {
  platform: NodeJS.Platform;
  /** macOS Spaces are Lume VMs: Apple silicon only. */
  macosSupported: boolean;
}

export interface CuaSpacesAvailability {
  installed: boolean;
  version: string | null;
  daemonUp: boolean;
  macosSupported: boolean;
  problem: string | null;
  installUrl: string;
}

export interface CuaSpaceStatus {
  backend: "cua-spaces";
  platform: NodeJS.Platform;
  installed: boolean;
  version: string | null;
  os: VmOs;
  space_name: string;
  image_ref: string;
  /** The Space's power state in the container backend's vocabulary, so the
   * shared lease, idle and wake logic reads both backends the same way. */
  container: "running" | "stopped" | "missing";
  /** Only this data directory's persisted creation receipt proves ownership. */
  managed: boolean;
  desktopReady: boolean;
  ready: boolean;
  resumable: boolean;
  create_supported: boolean;
  problem: string | null;
  stopped_at: null;
  target_key: string;
  /** Never a noVNC address: the Cua viewer is opened on request instead. */
  viewer_url: "";
}

// The CLI's JSON answers, parsed once at the boundary. Only the fields this
// adapter reads are named; Cua adds fields freely between releases.
const SpaceEntry = z.object({ name: z.string(), state: z.string().default(""), status: z.string().default("") });
type SpaceEntry = z.infer<typeof SpaceEntry>;
const SpaceList = z.array(z.unknown());
const CreateAnswer = z.object({ spaces: z.array(z.object({ error: z.string().optional(), id: z.string().optional(), added_at: z.string().optional() })) });
const RegistryList = z.object({ spaces: z.array(z.object({ id: z.string(), added_at: z.string().optional() })) });
const DaemonStatus = z.object({ pid: z.number() });
const ViewerAnswer = z.object({ url: z.string(), expires_at_unix: z.number().optional() });

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The CLI on the app's augmented PATH (the installer puts it in
 * ~/.local/bin), else the copy inside the Cua Spaces app on macOS. */
export function findCuaCli(platform: NodeJS.Platform = process.platform): string | null {
  const override = process.env.OMB_CUA_CLI;
  if (override !== undefined) return isAbsolute(override) && isExecutableFile(override) ? override : null;
  const name = platform === "win32" ? "cua.exe" : "cua";
  for (const dir of augmentedPath().split(delimiter)) {
    if (dir && isExecutableFile(join(dir, name))) return join(dir, name);
  }
  const bundled = "/Applications/Cua Spaces.app/Contents/MacOS/cua";
  return platform === "darwin" && isExecutableFile(bundled) ? bundled : null;
}

const runCua: CuaRunner = async (command, args, timeout = 30_000, cwd) => {
  const resolved = resolveCliSpawn(command, args);
  const { stdout } = await run(resolved.command, resolved.args, {
    timeout,
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PATH: augmentedPath() },
  });
  return { stdout };
};

let liveDeps: CuaDeps | null = null;
/** The real CLI. Re-resolved per call so installing Cua Spaces while the app
 * runs is picked up without a restart; caches below apply only to it. */
export function cuaDeps(): CuaDeps {
  const cli = findCuaCli();
  if (!liveDeps || liveDeps.cli !== cli) liveDeps = { cli, run: runCua, exec: runExec };
  return liveDeps;
}

export function cuaHost(platform: NodeJS.Platform = process.platform, arch: string = process.arch): CuaHost {
  return { platform, macosSupported: platform === "darwin" && arch === "arm64" };
}

/** One Space per Local VM target and OS. The key keeps the base prefix
 * (`shared`, `bot:…`, `pool:N`) so mode-specific checks still read it, and
 * gains the backend and OS so a container and a Space never share a lease,
 * idle timer or stop record. */
export function cuaSpaceTarget(base: LocalVmTarget, os: VmOs, title?: string): LocalVmTarget {
  return {
    key: `${base.key}:cua-${os}`,
    containerName: base.containerName,
    // A Space has no host-mounted workspace. Empty fails closed if a
    // container-only path ever receives this target.
    workspaceDir: "",
    viewerPort: null,
    label: base.label,
    space: { name: `${base.containerName}-${os}`, os, ...(title ? { title } : {}) },
  };
}

function requireSpace(target: LocalVmTarget): { name: string; os: VmOs; title?: string } {
  if (!target.space) throw new Error("not a Cua Space target");
  return target.space;
}

/** The name Cua Spaces shows for a Space ("OpenMausBot: Hawkeye (Linux)").
 * The sandbox name stays the stable, bot-derived identity; only this
 * registry label follows the bot's name. */
export function cuaSpaceTitle(label: string, os: VmOs): string {
  return `OpenMausBot: ${label.trim().slice(0, 60) || "desktop"} (${os === "macos" ? "macOS" : "Linux"})`;
}

/** Set the Space's display name in the Cua Spaces registry. Re-adding a
 * registered Space updates it in place; nothing in the Space changes. */
export async function cuaSpaceRetitle(target: LocalVmTarget, deps: CuaDeps = cuaDeps()): Promise<void> {
  const space = requireSpace(target);
  if (!deps.cli || !space.title) return;
  const status = await cuaSpaceStatus(target, deps);
  if (!status.managed || status.container === "missing") throw conflict(status.problem ?? "This Cua Space is not managed by OpenMausBot");
  try {
    await deps.run(deps.cli, ["spaces", "add", spaceRef(space.name), "--name", space.title, "--json"], 30_000);
  } catch (error) {
    throw Object.assign(new Error(cuaFailure(error)), { status: 502 });
  }
}

const spaceRef = (name: string) => `local:${name}`;

/** The most specific message a failed `cua` call carries: a per-Space error
 * in its JSON answer, else the last stderr line, else the spawn error.
 * execFile failures carry the child's stdout/stderr as string properties. */
export function cuaFailure(error: unknown): string {
  if (error instanceof Error) {
    const fromJson = "stdout" in error && typeof error.stdout === "string" ? spaceError(error.stdout) : null;
    if (fromJson) return fromJson;
    const stderr = "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim().split("\n").filter(Boolean).pop()
      : undefined;
    if (stderr) return stderr.replace(/^cua:\s*/, "");
    return error.message;
  }
  return String(error);
}

function spaceError(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null; // Not JSON: the caller falls back to stderr.
  }
  const answer = CreateAnswer.safeParse(parsed);
  return answer.success ? answer.data.spaces.find((space) => space.error)?.error ?? null : null;
}

/** Entries without a name are skipped rather than failing the listing:
 * another tool's sandbox must not hide this app's Spaces. */
export function parseSpaceList(stdout: string): SpaceEntry[] {
  return SpaceList.parse(JSON.parse(stdout)).flatMap((entry) => {
    const parsed = SpaceEntry.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

let listCache: { at: number; entries: Promise<SpaceEntry[]> } | null = null;

/** One listing serves every target probed in the same burst (inventory,
 * startup discovery, a status poll). Only the live CLI is cached.
 *
 * `--embedded` reads the sandbox state and runtimes directly. After a
 * `cua spaces delete` (by the person, outside this app), the daemon's
 * listing (cua 0.2.0) keeps the Space as "running/ready" until the daemon
 * restarts, which would mount tools on a desktop that no longer exists. */
async function listSpaces(deps: CuaDeps, cli: string): Promise<SpaceEntry[]> {
  const live = deps === liveDeps;
  if (live && listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.entries;
  const entries = deps.run(cli, ["sb", "ls", "--local", "--json", "--embedded"], 20_000).then(({ stdout }) => parseSpaceList(stdout));
  if (live) {
    listCache = { at: Date.now(), entries };
    entries.catch(() => {
      if (listCache?.entries === entries) listCache = null;
    });
  }
  return entries;
}
let registryCache: { at: number; entries: Promise<z.infer<typeof RegistryList>["spaces"]> } | null = null;

async function listRegistry(deps: CuaDeps, cli: string): Promise<z.infer<typeof RegistryList>["spaces"]> {
  const live = deps === liveDeps;
  if (live && registryCache && Date.now() - registryCache.at < LIST_TTL_MS) return registryCache.entries;
  const entries = deps.run(cli, ["spaces", "ls", "--json"], 20_000)
    .then(({ stdout }) => RegistryList.parse(JSON.parse(stdout)).spaces);
  if (live) {
    registryCache = { at: Date.now(), entries };
    entries.catch(() => {
      if (registryCache?.entries === entries) registryCache = null;
    });
  }
  return entries;
}

let versionCache: { at: number; cli: string; version: Promise<string | null> } | null = null;

async function cuaVersion(deps: CuaDeps, cli: string): Promise<string | null> {
  const live = deps === liveDeps;
  if (live && versionCache && versionCache.cli === cli && Date.now() - versionCache.at < VERSION_TTL_MS) {
    return versionCache.version;
  }
  const version = deps.run(cli, ["--version"], 5_000)
    .then(({ stdout }) => /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null)
    .catch(() => null);
  if (live) versionCache = { at: Date.now(), cli, version };
  return version;
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

function versionProblem(version: string | null): string | null {
  if (!version) return "The cua command did not report its version; reinstall Cua Spaces";
  return versionAtLeast(version, MIN_CUA_VERSION) ? null : `Update Cua Spaces to ${MIN_CUA_VERSION} or newer (found ${version})`;
}

/** Whether Settings may offer the backend, and why not. Never touches a Space. */
export async function cuaSpacesAvailability(
  deps: CuaDeps = cuaDeps(),
  host: CuaHost = cuaHost(),
): Promise<CuaSpacesAvailability> {
  const base = { macosSupported: host.macosSupported, installUrl: CUA_SPACES_INSTALL_URL };
  if (!deps.cli) {
    return { ...base, installed: false, version: null, daemonUp: false, problem: "Install Cua Spaces to use it for Local VMs" };
  }
  const cli = deps.cli;
  const [version, daemonUp] = await Promise.all([
    cuaVersion(deps, cli),
    deps.run(cli, ["daemon", "status", "--json"], 5_000)
      .then(({ stdout }) => DaemonStatus.safeParse(JSON.parse(stdout)).success)
      .catch(() => false),
  ]);
  return { ...base, installed: true, version, daemonUp, problem: versionProblem(version) };
}

/** The last failed create per target. A missing Space otherwise only says
 * "create it", and a turn that tried would lose the real reason (for example
 * macOS's Local Network permission for the Cua Spaces app). */
const createFailures = new Map<string, string>();
/** Targets with a create in flight. Cua lists a Space only once it exists,
 * and the first macOS Space spends many minutes downloading first; without
 * this every status read in between would offer "Create" again. */
const creating = new Set<string>();

export async function cuaSpaceStatus(
  target: LocalVmTarget,
  deps: CuaDeps = cuaDeps(),
  host: CuaHost = cuaHost(),
): Promise<CuaSpaceStatus> {
  const space = requireSpace(target);
  const ownership = cuaSpaceOwnership(space.name, deps.dataDir);
  const status: CuaSpaceStatus = {
    backend: "cua-spaces",
    platform: host.platform,
    installed: deps.cli !== null,
    version: null,
    os: space.os,
    space_name: space.name,
    image_ref: SPACE_IMAGES[space.os],
    container: "missing",
    managed: ownership !== null,
    desktopReady: false,
    ready: false,
    resumable: false,
    create_supported: false,
    problem: null,
    stopped_at: null,
    target_key: target.key,
    viewer_url: "",
  };
  if (!deps.cli) {
    status.problem = "Install Cua Spaces to use it for Local VMs";
    return status;
  }
  const cli = deps.cli;
  const [version, listed] = await Promise.all([
    cuaVersion(deps, cli),
    listSpaces(deps, cli).then(
      (entries) => ({ entries, error: null }),
      (error: unknown) => ({ entries: null, error: cuaFailure(error) }),
    ),
  ]);
  status.version = version;
  const unusable = versionProblem(version)
    ?? (space.os === "macos" && !host.macosSupported ? "macOS Spaces need a Mac with Apple silicon" : null);
  if (!listed.entries) {
    status.problem = `Cua Spaces is not responding: ${listed.error}`;
    return status;
  }
  const entry = listed.entries.find((candidate) => candidate.name === space.name);
  if (ownership?.addedAt) {
    try {
      const registry = await listRegistry(deps, cli);
      const registered = registry.find((candidate) => candidate.id === spaceRef(space.name));
      status.managed = registered ? registered.added_at === ownership.addedAt : !entry;
    } catch (error) {
      status.problem = `Cua Spaces is not responding: ${cuaFailure(error)}`;
      return status;
    }
  }
  if (!status.managed && (entry || ownership)) {
    if (entry) status.container = entry.state === "running" || STARTING_STATES.has(entry.state) ? "running" : "stopped";
    status.problem = "A Cua Space with this name exists that this OpenMausBot did not create; delete it in Cua, or rename it";
    return status;
  }
  if (!entry) {
    status.create_supported = unusable === null && !creating.has(target.key);
    status.problem = unusable
      ?? (creating.has(target.key)
        ? `Creating the Cua Space${space.os === "macos" ? " (the first macOS Space downloads about 27 GB)" : ""}`
        : createFailures.get(target.key) ?? "Create the Cua Space");
    return status;
  }
  createFailures.delete(target.key);
  if (entry.state === "running" || STARTING_STATES.has(entry.state)) {
    status.container = "running";
    status.desktopReady = entry.state === "running" && entry.status === "ready";
    status.ready = status.desktopReady && unusable === null;
    status.problem = unusable ?? (status.ready ? null : "The Cua Space is still starting");
    return status;
  }
  status.container = "stopped";
  if (STOPPED_STATES.has(entry.state)) {
    status.resumable = unusable === null;
    status.problem = unusable ?? "The Cua Space is stopped; start it to continue";
  } else {
    status.problem = unusable ?? `The Cua Space is ${entry.state || "in an unknown state"}${entry.status && entry.status !== entry.state ? ` (${entry.status})` : ""}`;
  }
  return status;
}

/** What a turn may do on its own to bring a Space up. */
export function cuaSpaceWakeAction(status: CuaSpaceStatus): "run" | "start" | null {
  if (status.container === "missing" && status.create_supported) return "run";
  if (status.resumable) return "start";
  return null;
}

function forgetCaches(target: LocalVmTarget): void {
  listCache = null;
  registryCache = null;
  frameStatusCache.delete(target.key);
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { status: 409 });
}

export async function cuaSpaceAction(
  action: LifecycleAction,
  target: LocalVmTarget,
  deps: CuaDeps = cuaDeps(),
  host: CuaHost = cuaHost(),
): Promise<CuaSpaceStatus> {
  const space = requireSpace(target);
  forgetCaches(target);
  const before = await cuaSpaceStatus(target, deps, host);
  if (!deps.cli) throw conflict(before.problem ?? "Install Cua Spaces first");
  const cli = deps.cli;
  const ref = spaceRef(space.name);
  if (before.problem?.startsWith("Cua Spaces is not responding:")) throw Object.assign(new Error(before.problem), { status: 502 });
  if (before.container !== "missing" && !before.managed) throw conflict(before.problem ?? "This Cua Space is not managed by OpenMausBot");
  if (action === "pull") throw conflict("Cua Spaces downloads the desktop image when it creates the Space");
  if (action === "run") {
    if (before.container !== "missing") throw conflict("This Cua Space already exists; delete it before creating a replacement");
    if (!before.create_supported) throw conflict(before.problem ?? "This Cua Space cannot be created here");
    creating.add(target.key);
    try {
      // Persist before invoking Cua: an interrupted create is still ours.
      recordCuaSpaceOwnership(space.name, deps.dataDir);
      const { stdout } = await deps.run(
        cli,
        ["spaces", "create", SPACE_IMAGES[space.os], "--on", "local", "--name", space.name, "--json"],
        CREATE_TIMEOUT_MS,
      );
      const failed = spaceError(stdout);
      if (failed) throw Object.assign(new Error(failed), { stdout });
      const answer = CreateAnswer.safeParse(JSON.parse(stdout));
      const addedAt = answer.success ? answer.data.spaces.find((entry) => entry.id === ref)?.added_at : undefined;
      if (addedAt) recordCuaSpaceOwnership(space.name, deps.dataDir, addedAt);
      forgetCaches(target);
      createFailures.delete(target.key);
      // The display name only labels the Space in Cua Spaces; a Space that
      // could not be labelled is still a working desktop.
      await cuaSpaceRetitle(target, deps).catch(() => {});
    } catch (error) {
      const message = `Creating the Cua Space failed: ${cuaFailure(error)}`;
      createFailures.set(target.key, message);
      throw Object.assign(new Error(message), { status: 502 });
    } finally {
      creating.delete(target.key);
      forgetCaches(target);
    }
  } else if (action === "remove") {
    if (!before.managed) return before;
    // `cua spaces delete` (0.2.0) removes the sandbox behind the daemon's
    // back: the daemon keeps routing that name to the dead Space, so every
    // later Space of the same name fails. Delete through the daemon, then
    // forget the Spaces registration it leaves behind.
    await removeStep(deps, cli, ["sb", "rm", ref, "--force", "--json"], target);
    await removeStep(deps, cli, ["spaces", "rm", ref, "--json"], target);
    forgetCuaSpaceOwnership(space.name, deps.dataDir);
  } else if (action === "start") {
    if (!before.resumable) throw conflict(before.problem ?? "The Cua Space is not stopped");
    await lifecycle(deps, cli, ["spaces", "start", ref, "--json"], target);
  } else {
    if (before.container !== "running") throw conflict("The Cua Space is not running");
    await lifecycle(deps, cli, ["spaces", "stop", ref, "--json"], target);
  }
  return cuaSpaceStatus(target, deps, host);
}

/** Sandbox deletion and registry deletion are separately idempotent. Keep
 * the receipt until both succeed so a registry failure can be repaired. */
async function removeStep(deps: CuaDeps, cli: string, args: string[], target: LocalVmTarget): Promise<void> {
  try {
    await lifecycle(deps, cli, args, target);
  } catch (error) {
    if (!explicitNotFound(cuaFailure(error))) throw error;
  }
}

function explicitNotFound(message: string): boolean {
  return /^not found:/i.test(message);
}

async function lifecycle(deps: CuaDeps, cli: string, args: string[], target: LocalVmTarget): Promise<void> {
  try {
    await deps.run(cli, args, LIFECYCLE_TIMEOUT_MS);
  } catch (error) {
    throw Object.assign(new Error(cuaFailure(error)), { status: 502 });
  } finally {
    forgetCaches(target);
  }
}

const frameStatusCache = new Map<string, number>();

/** The raw frame for the live poller and the Computer panel preview. */
export async function cuaSpaceFrame(
  target: LocalVmTarget,
  deps: CuaDeps = cuaDeps(),
): Promise<{ png: string; format: "png" | "jpeg" }> {
  const space = requireSpace(target);
  const live = deps === liveDeps;
  const checkedAt = frameStatusCache.get(target.key);
  if (!live || checkedAt === undefined || Date.now() - checkedAt > FRAME_STATUS_TTL_MS) {
    const status = await cuaSpaceStatus(target, deps);
    if (!status.ready) {
      frameStatusCache.delete(target.key);
      throw conflict(status.problem ?? "The Cua Space is not ready");
    }
    if (live) frameStatusCache.set(target.key, Date.now());
  }
  if (!deps.cli) throw conflict("Install Cua Spaces first");
  const dir = await mkdtemp(join(tmpdir(), "omb-cua-frame-"));
  try {
    const file = join(dir, "frame.png");
    await deps.run(deps.cli, ["sb", "screenshot", spaceRef(space.name), "-o", file, "--json"], 30_000);
    const bytes = await readFile(file);
    const checked = wholeScreenshot(bytes);
    if (!checked.ok) throw Object.assign(new Error("Cua Spaces returned an incomplete screenshot"), { status: 502 });
    return { png: bytes.toString("base64"), format: checked.mime === "image/jpeg" ? "jpeg" : "png" };
  } catch (error) {
    frameStatusCache.delete(target.key);
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function cuaSpaceScreenshot(target: LocalVmTarget, deps: CuaDeps = cuaDeps()): Promise<string> {
  const { png, format } = await cuaSpaceFrame(target, deps);
  return `data:image/${format};base64,${png}`;
}

/** `cua mcp` scoped to exactly this Space with only the computer tools: no
 * Space lifecycle, no other Spaces, no skills. Permissions fail closed. */
export function cuaSpaceMcp(
  target: LocalVmTarget,
  control?: { url: string; token: string },
  cli: string | null = cuaDeps().cli,
): LocalVmMcpLaunch {
  const space = requireSpace(target);
  if (!cli) throw conflict("Install Cua Spaces first");
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.cuaSpacesMcp, cli, spaceRef(space.name)],
    // The control pair rides in env, not argv — argv is world-readable
    // through `ps` for the life of the bridge.
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...(control ? { OMB_CONTROL_URL: control.url, OMB_CONTROL_TOKEN: control.token } : {}),
    },
  };
}

const ipv4 = (address: string): number | null => {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts.reduce((value, part) => value * 256 + part, 0)
    : null;
};

/** Loopback (container Spaces publish there), or a guest on one of this
 * Mac's own Virtualization NAT bridges (`bridge100`, `bridge101`, …), where a
 * macOS Space's cua-spacesd listens. A LAN interface, or `bridge0` (the
 * Thunderbolt bridge to another machine), never qualifies. */
export function onThisMachine(hostname: string, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): boolean {
  if (["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return true;
  if (process.platform !== "darwin") return false;
  const host = ipv4(hostname);
  if (host === null) return false;
  return Object.entries(interfaces).some(([name, addresses]) => /^bridge1\d\d$/.test(name)
    && (addresses ?? []).some((entry) => {
      const address = entry.family === "IPv4" ? ipv4(entry.address) : null;
      const mask = ipv4(entry.netmask);
      return address !== null && mask !== null && (address & mask) >>> 0 === (host & mask) >>> 0;
    }));
}

/** A one-hour link to Cua's own HTML5 viewer for this Space, with keyboard,
 * mouse and clipboard. Viewing never pauses the bot: the person and the bot
 * can use the desktop together. Pausing the bot is the separate computer-
 * control hold the Computer panel takes for "Take control". */
export async function cuaSpaceViewerLink(
  target: LocalVmTarget,
  deps: CuaDeps = cuaDeps(),
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): Promise<{ url: string; expiresAt: number | null }> {
  const space = requireSpace(target);
  if (!deps.cli) throw conflict("Install Cua Spaces first");
  try {
    const { stdout } = await deps.run(
      deps.cli,
      ["sb", "view", spaceRef(space.name), "--no-open", "--json", "--ttl", "1h"],
      20_000,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(stdout.trim() || "Cua Spaces returned no viewer link");
    }
    const answer = ViewerAnswer.safeParse(parsed);
    if (!answer.success) throw new Error("Cua Spaces returned no viewer link");
    const url = new URL(answer.data.url);
    // The bearer ticket is only handed on when it points at this machine.
    if (url.protocol !== "http:" || !onThisMachine(url.hostname, interfaces)) {
      throw new Error("Cua Spaces returned a non-local viewer link");
    }
    return {
      url: url.toString(),
      expiresAt: answer.data.expires_at_unix === undefined ? null : answer.data.expires_at_unix * 1000,
    };
  } catch (error) {
    throw Object.assign(new Error(cuaFailure(error)), { status: 502 });
  }
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Perl is part of macOS. Fork a new session for the guest command so the
 * watchdog terminates its descendants as well as its shell, then reports
 * the same timeout exit code as Linux's coreutils timeout. */
const MACOS_WATCHDOG = [
  "my $seconds = shift @ARGV;",
  "my $pid = fork; defined $pid or die \"fork: $!\";",
  "if (!$pid) { setsid() >= 0 or die \"setsid: $!\"; exec @ARGV; die \"exec: $!\"; }",
  "$SIG{ALRM} = sub { kill 'TERM', -$pid; select undef, undef, undef, 5; kill 'KILL', -$pid; waitpid $pid, 0; exit 124; };",
  "alarm $seconds; waitpid $pid, 0; my $status = $?; alarm 0;",
  "exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);",
].join(" ");

/** vm_exec bounds the command inside either guest, not just its host client. */
export async function cuaSpaceExec(
  target: LocalVmTarget,
  command: string,
  options: { timeoutSeconds?: number; deps?: CuaDeps } = {},
): Promise<ContainerExecResult> {
  const space = requireSpace(target);
  const seconds = checkedExecSeconds(command, options.timeoutSeconds);
  const deps = options.deps ?? cuaDeps();
  if (!deps.cli) throw conflict("Install Cua Spaces first");
  const line = space.os === "linux"
    ? `cd ~ && timeout -k 5 ${seconds} sh -lc ${shellQuote(command)}`
    : `cd ~ && /usr/bin/perl -MPOSIX=setsid -e ${shellQuote(MACOS_WATCHDOG)} ${seconds} sh -lc ${shellQuote(command)}`;
  // `cua sb exec` joins its arguments into one `sh -c` line, so the
  // already-quoted line goes as a single argument.
  const result = await deps.exec(deps.cli, ["sb", "exec", spaceRef(space.name), line], { timeout: (seconds + 20) * 1000 });
  return {
    exitCode: result.code,
    stdout: clipExecOutput(result.stdout),
    stderr: clipExecOutput(result.stderr),
    timedOut: result.code === 124 || result.code === 137,
  };
}

const homeCache = new Map<string, string>();

/** The Space user's home: where relative attach_file paths resolve. */
export async function cuaSpaceHome(target: LocalVmTarget, deps: CuaDeps = cuaDeps()): Promise<string> {
  const cached = homeCache.get(target.key);
  if (cached) return cached;
  const space = requireSpace(target);
  if (!deps.cli) throw conflict("Install Cua Spaces first");
  const result = await deps.exec(deps.cli, ["sb", "exec", spaceRef(space.name), `printf %s "$HOME"`], { timeout: 20_000 });
  const home = result.stdout.trim();
  if (result.code !== 0 || !home.startsWith("/")) throw Object.assign(new Error("Could not read the Cua Space's home folder"), { status: 502 });
  homeCache.set(target.key, home);
  return home;
}

/** attach_file reads host files, and a Space mounts no host folder. Copy the
 * one requested guest file into a private staging folder and map its guest
 * folder onto it, so the attachment rules for a mounted VM apply unchanged.
 * Null when the Space has no such file: the caller then searches only the
 * bot's own host folders. */
export async function stageCuaSpaceFile(
  target: LocalVmTarget,
  requested: string,
  deps: CuaDeps = cuaDeps(),
): Promise<{ path: string; guest: { root: string; host: string }; dispose: () => Promise<void> } | null> {
  const space = requireSpace(target);
  if (!deps.cli || !requested.trim()) return null;
  if (requested.includes(":")) throw Object.assign(new Error("Cua Space attachment paths cannot contain ':'; rename the file before attaching it"), { status: 400 });
  let home: string;
  try {
    home = await cuaSpaceHome(target, deps);
  } catch {
    // Home discovery is only needed for guest lookup; host roots still apply.
    return null;
  }
  const absolute = requested.startsWith("/");
  const guestPath = absolute ? posix.normalize(requested) : posix.join(home, requested.replace(/^~(?:\/|$)/, ""));
  const root = absolute ? posix.dirname(guestPath) : home;
  const relative = posix.relative(root, guestPath);
  if (!relative || relative.startsWith("..")) return null;
  const host = await mkdtemp(join(tmpdir(), "omb-cua-attach-"));
  const dispose = () => rm(host, { recursive: true, force: true });
  const destination = join(host, ...relative.split("/"));
  try {
    await mkdir(dirname(destination), { recursive: true });
    // Relative to the staging folder, so the host side never contains a
    // drive letter `cua sb cp` could read as a sandbox name.
    await deps.run(deps.cli, ["sb", "cp", `${spaceRef(space.name)}:${guestPath}`, relative], 2 * 60_000, host);
  } catch (error) {
    await dispose();
    const message = cuaFailure(error);
    if (explicitNotFound(message)
      || /^file not found(?:\s|:|$)/i.test(message)
      || (message.includes(guestPath) && /: no such file or directory(?:\s|$)/i.test(message))) return null;
    throw Object.assign(new Error(message), { status: 502 });
  }
  return { path: guestPath, guest: { root, host }, dispose };
}

/** The targets whose Spaces exist, from one listing. */
export async function existingCuaSpaces(
  targets: LocalVmTarget[],
  deps: CuaDeps = cuaDeps(),
): Promise<LocalVmTarget[]> {
  if (!deps.cli) throw conflict("Install Cua Spaces to use it for Local VMs");
  const names = new Set((await listSpaces(deps, deps.cli)).map((entry) => entry.name));
  return targets.filter((target) => target.space && names.has(target.space.name));
}
