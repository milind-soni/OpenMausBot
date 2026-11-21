// The bot box's plan: what one boxed process sees, as a list of mounts and the bubblewrap argv that makes it.
//
// What the box sees:
//   - the image's code read-only: /usr (with /bin, /lib, /lib64 and /sbin as the links a merged-/usr Debian has), /etc,
//     /opt (the bots' browser) and the server's own code folder, so the engine CLIs and the proxies they start run;
//   - its HOME read-write (the engine's own login and settings live there), with the server's data folder replaced by an
//     empty private folder, so messages.db, config.json, logins, other bots' folders and the server's sockets are not there;
//     on a Team Cloud that HOME is the audience's engine home instead (server/engine-homes), with only the team's engine
//     sign-ins bound into it, so no other audience's transcripts are there;
//   - put back inside that empty folder: this turn's working folder, the bot's own folder (workspaces/<bot>) and what the
//     caller names (the turn's permission socket, a read-only file the command line points at); and, read-only, the
//     bot's own SOUL.md (bots/<bot>/SOUL.md, which it may read but never write) and the engines OpenMausBot installed
//     there, whole, since npm's bin links point into the prefix by relative paths; on a Team Cloud a turn that is not the
//     team's has the bot's own folder read-only and of a process its conversations share only those it may read
//     (BoxAudience);
//   - a private /proc (its own PID namespace: other turns' processes do not exist for it), /dev, /tmp and /run;
//   - of /sys, only the machine's CPU list, read-only;
//   - a network namespace with loopback only. Two loopback ports inside are bridged to unix sockets bound in from outside:
//     the egress gate (every connection to the internet goes through it) and the harness gate (only /api/internal/
//     routes of this server). Nothing else on the server's loopback is reachable. A box that waits for a sign-in callback
//     also dials out to one more socket, through which the server reaches the box's own loopback, never the other way.
import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { isLayerId } from "../audience.ts";

export type BoxNet = "isolated" | "shared";

/** One line of the plan. `bind` is read-write, `ro` read-only; `tmpfs` an empty private folder; `symlink` a link. */
export type Mount =
  | { kind: "ro" | "bind"; source: string; target: string; optional?: boolean }
  | { kind: "tmpfs" | "proc" | "dev" | "dir"; target: string }
  | { kind: "symlink"; link: string; target: string };

export interface BoxBridge { port: number; socket: string; name: string }

/** What the box runner knows once, at start. */
export interface BoxSetup {
  dataDir: string;
  /** The server's HOME: the engines' logins and settings. */
  home: string;
  /** Folders of code the box may read: the server's own files, the bots' browser. */
  codeRoots: readonly string[];
  /** Folders of engine code OpenMausBot installed in the data folder, read-only at their own paths; absent ones are skipped. */
  engineRoots: readonly string[];
  /** Host unix sockets bridged to loopback ports inside the box, when the box has its own network. */
  bridges: readonly BoxBridge[];
  /** The descriptor number the box reads its seccomp filter from (`--seccomp FD`), or none. */
  seccompFd?: number;
  /** Test knobs; production passes none. */
  mutate?: ReadonlySet<BoxMutation>;
}

/** Each removes one protection, so a test can prove the matching check fails without it. */
export type BoxMutation = "bind-data" | "bind-otherws" | "share-pid" | "share-net" | "env-all" | "tmp-shared" | "no-seccomp" | "engines-rw";
export const BOX_MUTATIONS: readonly BoxMutation[] = ["bind-data", "bind-otherws", "share-pid", "share-net", "env-all", "tmp-shared", "no-seccomp", "engines-rw"];

export interface BoxRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  /** The environment the caller built for the process; the plan keeps only the allowed names (env.ts). */
  env: Record<string, string | undefined>;
  /** Names of `env` this process keeps although the allow-list or the workspace-credential deny would drop them: the keys
   * the person saved for this engine. Never a never-list or `OMB_` name. */
  allowEnv?: readonly string[];
  /** More read-write paths: a permission socket, a browser profile. */
  rw?: readonly string[];
  /** More read-only paths. */
  ro?: readonly string[];
  /** `shared`: the host's network (a browser, which already goes through its own gate). Default `isolated`. */
  net?: BoxNet;
  /** The bot whose own folder (workspaces/<bot>) is put back; derived from a task-workspace cwd when absent. */
  botId?: string;
  /** One process serves every conversation of the bot (a shared OpenCode process): all of the bot's conversation folders
   * are read-write and all of their uploads read-only, in place of only the starting conversation's. */
  botThreads?: boolean;
  /** A Team Cloud audience's engine home, bound read-write in place of the server's HOME, none of which the box then has. */
  home?: string;
  /** Files bound read-write over their names in `home`: the team's engine sign-ins. */
  shared?: ReadonlyArray<{ source: string; target: string }>;
  /** The command, its arguments and its environment are a server someone configured (an MCP server a bot may have
   * added), not ones OpenMausBot built. Security: none of them puts anything of the data folder in the box but the
   * bot's own folders, so an environment value naming a folder there is not made writable. */
  configured?: boolean;
  /** A host unix socket the box dials out to, so the server can reach a port the engine listens on inside the box's own
   * network, such as a sign-in's callback. Only an isolated box has one. */
  relay?: string;
  /** The conversation this spawn runs for, when the caller knows it (a Team Cloud's engine homes do). */
  threadId?: string;
  /** With `botId`, for a turn working outside its conversation's folder (a configured project folder): that folder
   * (task-workspaces/<botId>/<thread>, its handed-off files), put back read-write where it exists. */
  conversationFolder?: string;
  /** The bot whose turn that is, for the audience rule only (BoxAudience); unlike `botId` it puts back nothing. */
  conversationBot?: string;
  /** On a Team Cloud: what the conversation's audience gives the box of the bot's team things (BoxAudience). */
  audience?: BoxAudience;
}

/** On a Team Cloud, what one conversation's boxes get of what is the team's (docs/team-cloud.md, "The audience rule"):
 * a turn writes only into its own audience, and reads only what everyone who sees its answer may see. */
export interface BoxAudience {
  /** The turn is not the team's: the bot's own folder (workspaces/<bot>, the team's notes and skills) is put back
   * read-only, after every read-write line. Where that folder is the turn's working folder (a room's), files can still
   * be made in it, and only the team's notes and skills there (MEMORY.md, memory/, skills/) are read-only. */
  teamReadOnly: boolean;
  /** With `botThreads`: the bot's conversations the shared process may see, in place of all of them. Its own audience's
   * read-write, the team's read-only; another person's never. */
  threads?: { rw: readonly string[]; ro: readonly string[] };
  /** The Team Cloud's shared folder (team-files/), at TEAM_FILES_IN_BOX in every box of a turn: read-only, or read-write
   * for a bot an admin marked "Can edit team files" while the folder has room (server/host/team-files.ts). */
  teamFiles?: { source: string; write: boolean };
}

/** Where every bot's box has its Team Cloud's shared folder. */
export const TEAM_FILES_IN_BOX = "/team-files";
/** Its template library, read-only in every box. */
export const TEAM_FILES_LIBRARY = "templates";

/** What stays read-only in a bot's own folder that is a non-team turn's working folder. */
export const TEAM_FOLDER_KEPT = ["MEMORY.md", "memory", "skills"] as const;

export interface BoxPlan {
  mounts: Mount[];
  /** bubblewrap's own options, before `--` and the command. */
  options: string[];
  net: BoxNet;
  /** The paths read-write inside, for the self-report and tests. */
  writable: string[];
  botId: string | null;
}

export const IN_BOX_SOCKET_DIR = "/run/omb";
export const RELAY_SOCKET_NAME = "relay";
export const BOX_HOSTNAME = "omb-box";
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `child` is `parent` or below it. */
export function under(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The bot and conversation of a task workspace (`<data>/task-workspaces/<bot>/<thread>`), or null. */
export function taskWorkspaceIds(cwd: string, dataDir: string): { botId: string; threadId: string } | null {
  const rel = relative(join(dataDir, "task-workspaces"), cwd).split(sep);
  if (rel.length < 2 || !ID.test(rel[0]!) || !ID.test(rel[1]!) || rel[0] === ".." ) return null;
  return { botId: rel[0]!, threadId: rel[1]! };
}

/** The conversation whose uploads a box in `cwd` sees: a conversation folder's own, or for a turn working in its bot's own
 * folder (workspaces/<bot>: a room, a bot whose folder is its own), that turn's conversation. Null for any other folder. */
export function uploadsConversation(cwd: string, dataDir: string, turn?: { botId: string; threadId: string } | null): { botId: string; threadId: string } | null {
  const ids = taskWorkspaceIds(cwd, dataDir);
  if (ids || !turn || !ID.test(turn.botId) || !ID.test(turn.threadId)) return ids;
  return cwd === join(dataDir, "workspaces", turn.botId) ? { botId: turn.botId, threadId: turn.threadId } : null;
}

/** The conversation whose uploads a box for `request` sees: its conversation folder's, or for a turn in its bot's own
 * folder, that turn's (`request.conversationFolder`, of the same bot). Null for any other box. */
export function boxUploadsConversation(request: BoxRequest, dataDir: string): { botId: string; threadId: string } | null {
  const cwd = request.cwd ? resolve(request.cwd) : null;
  if (!cwd) return null;
  const ids = taskWorkspaceIds(cwd, dataDir);
  if (ids) return ids;
  const turn = request.conversationFolder ? taskWorkspaceIds(resolve(request.conversationFolder), dataDir) : null;
  return turn && turn.botId === request.botId ? uploadsConversation(cwd, dataDir, turn) : null;
}

/** The server-owned folder holding a conversation's uploads for its boxes (server/box-attachments.ts), bound read-only. */
export function boxUploadsDir(dataDir: string, botId: string, threadId: string): string {
  return join(dataDir, "box-uploads", botId, threadId);
}

/** Absolute paths on the command line (`/x/y` or `--flag=/x/y`), which the engine must be able to read. */
export function argvPaths(args: readonly string[]): string[] {
  const paths: string[] = [];
  for (const arg of args) {
    const optionValue = arg.startsWith("--") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    const value = optionValue.startsWith("@") ? optionValue.slice(1) : optionValue;
    if (isAbsolute(value) && value.length > 1 && !paths.includes(value)) paths.push(resolve(value));
  }
  return paths;
}

/** Environment values that name folders the engine writes: its own config and caches. */
export const PATH_ENV_NAMES = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "GROK_HOME", "OPENCODE_HOME", "HERMES_HOME", "GEMINI_HOME", "PI_CODING_AGENT_DIR", "TMPDIR"] as const;

/** The only part of /sys the box has: how many CPUs the machine has. Programs built with TCMalloc (Google's Antigravity
 * runtime) read `possible` at start and stop themselves (SIGABRT, exit 134) when it is missing. */
export const CPU_LIST_FILES = ["/sys/devices/system/cpu/possible", "/sys/devices/system/cpu/online"] as const;

/** Folders the box always has its own copy of, so no setting may put the host's back. */
const PRIVATE_INSIDE = ["/tmp", "/var/tmp", "/run", "/dev", "/proc"];

function assertReadOnlySource(source: string): void {
  try {
    const stat = statSync(source);
    if (stat.isFile() && stat.nlink > 1) {
      throw new Error(`The bot box refuses a multiply-linked read-only file: ${source}; grant a separate single-link copy instead.`);
    }
  } catch (error) {
    if (!["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

export function planBox(setup: BoxSetup, request: BoxRequest): BoxPlan {
  const mutate = setup.mutate ?? new Set<BoxMutation>();
  const dataDir = resolve(setup.dataDir), home = resolve(setup.home);
  const net: BoxNet = mutate.has("share-net") ? "shared" : request.net ?? "isolated";
  const mounts: Mount[] = [
    { kind: "ro", source: "/usr", target: "/usr" },
    { kind: "symlink", link: "/bin", target: "usr/bin" },
    { kind: "symlink", link: "/lib", target: "usr/lib" },
    { kind: "symlink", link: "/lib64", target: "usr/lib64" },
    { kind: "symlink", link: "/sbin", target: "usr/sbin" },
    { kind: "ro", source: "/etc", target: "/etc" },
    { kind: "ro", source: "/opt", target: "/opt", optional: true },
    { kind: "ro", source: "/var/lib", target: "/var/lib", optional: true },
    ...CPU_LIST_FILES.map((file): Mount => ({ kind: "ro", source: file, target: file, optional: true })),
  ];
  for (const root of setup.codeRoots) {
    const code = resolve(root);
    if (["/usr", "/etc", "/opt", "/var/lib"].some((base) => under(code, base))) continue;
    mounts.push({ kind: "ro", source: code, target: code });
  }
  mounts.push({ kind: "proc", target: "/proc" }, { kind: "dev", target: "/dev" });
  if (mutate.has("tmp-shared")) mounts.push({ kind: "bind", source: "/tmp", target: "/tmp" });
  else mounts.push({ kind: "tmpfs", target: "/tmp" });
  mounts.push({ kind: "tmpfs", target: "/var/tmp" }, { kind: "tmpfs", target: "/run" });

  const writable: string[] = [];
  const rw = (path: string) => {
    mounts.push({ kind: "bind", source: path, target: path });
    if (!writable.includes(path)) writable.push(path);
  };
  // HOME first; the data folder is replaced by an empty one right after, so the lines below put back only what is named.
  // An engine home lives in the data folder, so it goes back after that.
  const ownHome = request.home ? resolve(request.home) : null;
  if (!ownHome) rw(home);
  const dataInsideHome = under(dataDir, home);
  if (!mutate.has("bind-data")) {
    if (dataInsideHome) mounts.push({ kind: "tmpfs", target: dataDir });
  } else {
    rw(dataDir);
  }
  if (ownHome) rw(ownHome);
  const dataHidden = !mutate.has("bind-data");
  /** A path is already readable and writable through an earlier line (and not hidden by the data folder's tmpfs). */
  const covered = (path: string) => (ownHome !== null && under(path, ownHome)) || (writable.some((root) => under(path, root)) && !(dataHidden && under(path, dataDir)));

  const cwd = request.cwd ? resolve(request.cwd) : null;
  const ids = cwd ? taskWorkspaceIds(cwd, dataDir) : null;
  const botId = request.botId ?? ids?.botId ?? null;
  const threads = request.botThreads && ids ? ids.botId : null;
  const scoped = threads ? request.audience?.threads ?? null : null;
  if (threads && !scoped) rw(join(dataDir, "task-workspaces", threads));
  for (const id of scoped?.rw ?? []) {
    if (!ID.test(id)) continue;
    const folder = join(dataDir, "task-workspaces", threads!, id);
    // A conversation whose folder is not made yet is skipped, as its turn makes it and starts a box of its own.
    mounts.push({ kind: "bind", source: folder, target: folder, optional: true });
    if (!writable.includes(folder)) writable.push(folder);
  }
  if (cwd && !covered(cwd)) rw(cwd);
  // Security: on a Team Cloud a turn that is not the team's never writes the team's folder (BoxAudience.teamReadOnly).
  const teamFolder = request.audience?.teamReadOnly ? teamFolderOf(botId, cwd, dataDir) : null;
  const workingInTeamFolder = teamFolder !== null && cwd !== null && under(cwd, teamFolder);
  if (botId && ID.test(botId)) {
    const own = join(dataDir, "workspaces", botId);
    if (!covered(own) && own !== teamFolder) rw(own);
  }
  const ownFolders = botId && ID.test(botId) ? [join(dataDir, "workspaces", botId), join(dataDir, "task-workspaces", botId)] : [];
  // Security: only a conversation folder of this box's own bot, and never in a process other conversations share.
  const conversation = request.conversationFolder && !request.botThreads ? resolve(request.conversationFolder) : null;
  if (conversation && botId && ID.test(botId) && taskWorkspaceIds(conversation, dataDir)?.botId === botId && !covered(conversation)) {
    mounts.push({ kind: "bind", source: conversation, target: conversation, optional: true });
    if (!writable.includes(conversation)) writable.push(conversation);
  }
  if (mutate.has("bind-otherws")) {
    rw(join(dataDir, "workspaces"));
    rw(join(dataDir, "task-workspaces"));
  }
  for (const name of PATH_ENV_NAMES) {
    const value = request.env[name];
    // A temp folder stays the box's own private one; anything else the engine writes is put back.
    if (!value || !isAbsolute(value) || covered(resolve(value)) || PRIVATE_INSIDE.some((base) => under(resolve(value), base))) continue;
    if (request.configured && (under(resolve(value), dataDir) || under(dataDir, resolve(value))) && !ownFolders.some((folder) => under(resolve(value), folder))) continue;
    rw(resolve(value));
  }
  for (const path of request.rw ?? []) if (!covered(resolve(path))) rw(resolve(path));
  if (ownHome) {
    for (const file of request.shared ?? []) {
      if (under(resolve(file.target), ownHome)) mounts.push({ kind: "bind", source: resolve(file.source), target: resolve(file.target), optional: true });
    }
  }
  // After every read-write line, so none of them can make an engine another conversation also runs writable.
  for (const root of setup.engineRoots) {
    const engines = resolve(root);
    mounts.push({ kind: mutate.has("engines-rw") ? "bind" : "ro", source: engines, target: engines, optional: true });
  }
  // The person's uploads for this conversation, after every read-write line: readable, but never writable or swappable.
  // A turn in its bot's own folder sees only its own conversation's: a process there is never shared with another
  // conversation (procs.ts sharedBoxScope), so this holds for one started for several of them too.
  const uploadsOf = boxUploadsConversation(request, dataDir);
  if (uploadsOf) {
    const shown = scoped ? [...scoped.rw, ...scoped.ro].filter((id) => ID.test(id)).map((id) => boxUploadsDir(dataDir, threads!, id))
      : [threads ? join(dataDir, "box-uploads", threads) : boxUploadsDir(dataDir, uploadsOf.botId, uploadsOf.threadId)];
    for (const folder of shown) mounts.push({ kind: "ro", source: folder, target: folder, optional: true });
  }
  // The team's conversations a non-team shared process may read, and the team's folder, after every read-write line too.
  for (const id of scoped?.ro ?? []) {
    if (ID.test(id)) mounts.push({ kind: "ro", source: join(dataDir, "task-workspaces", threads!, id), target: join(dataDir, "task-workspaces", threads!, id), optional: true });
  }
  if (teamFolder && workingInTeamFolder) {
    for (const name of TEAM_FOLDER_KEPT) mounts.push({ kind: "ro", source: join(teamFolder, name), target: join(teamFolder, name), optional: true });
  } else if (teamFolder) {
    mounts.push({ kind: "ro", source: teamFolder, target: teamFolder, optional: true });
  }
  const readOnly = new Set<string>();
  const inBotFolder = (path: string) => ["workspaces", "task-workspaces"].some((kind) => {
    const [owner, ...rest] = relative(join(dataDir, kind), path).split(sep);
    return owner !== undefined && ID.test(owner) && !rest.includes("..") && (botId ? owner === botId : true);
  });
  const named = new Set((request.ro ?? []).map((path) => resolve(path)));
  // Only a caller's own `ro` grant may put a read-only copy over a writable folder, never the implicit SOUL.md line.
  const asked = new Set(named);
  if (botId && ID.test(botId)) named.add(join(dataDir, "bots", botId, "SOUL.md"));
  for (const path of [...(request.ro ?? []), ...argvPaths(request.args), ...(botId && ID.test(botId) ? [join(dataDir, "bots", botId, "SOUL.md")] : [])]) {
    const full = resolve(path);
    if (request.ro?.includes(path)) assertReadOnlySource(full);
    // Security: a command line is not a grant. A path on one that is in the data folder, or holds it, is shown only
    // when the caller named it in `ro`, or when it is in a bot's folder: this box's bot's, or any bot's where the caller
    // gave no bot (a configured server's program lives in the folder of the bot that added it).
    if (!named.has(full) && (under(full, dataDir) || under(dataDir, full)) && !covered(full) && !inBotFolder(full)) continue;
    // Code and the system are already there; a file under HOME or /tmp the command line names is put back read-only.
    if ((!asked.has(full) && covered(full)) || readOnly.has(full)) continue;
    if (["/usr", "/etc", "/opt", "/var/lib", ...setup.codeRoots, ...setup.engineRoots].some((base) => under(full, resolve(base)))) continue;
    readOnly.add(full);
    mounts.push({ kind: "ro", source: full, target: full, optional: true });
  }

  // The team's shared folder, at one path in every box: its own line, as nothing else is bound there.
  const teamFiles = request.audience?.teamFiles;
  if (teamFiles) {
    mounts.push({ kind: teamFiles.write ? "bind" : "ro", source: resolve(teamFiles.source), target: TEAM_FILES_IN_BOX, optional: true });
    if (teamFiles.write && !writable.includes(TEAM_FILES_IN_BOX)) writable.push(TEAM_FILES_IN_BOX);
    // The team's template library (server/team-templates.ts) is its admins', so it stays read-only for a bot that may edit.
    if (teamFiles.write) mounts.push({ kind: "ro", source: join(resolve(teamFiles.source), TEAM_FILES_LIBRARY), target: join(TEAM_FILES_IN_BOX, TEAM_FILES_LIBRARY), optional: true });
  }

  const options = ["--unshare-user", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--die-with-parent", "--hostname", BOX_HOSTNAME];
  if (!mutate.has("share-pid")) options.push("--unshare-pid");
  if (setup.seccompFd !== undefined && !mutate.has("no-seccomp")) options.push("--seccomp", String(setup.seccompFd));
  if (net === "isolated") {
    options.push("--unshare-net");
    mounts.push({ kind: "dir", target: IN_BOX_SOCKET_DIR });
    for (const bridge of setup.bridges) mounts.push({ kind: "bind", source: bridge.socket, target: join(IN_BOX_SOCKET_DIR, `${bridge.name}.sock`) });
    if (request.relay) mounts.push({ kind: "bind", source: resolve(request.relay), target: inBoxSocket(RELAY_SOCKET_NAME) });
  }
  if (cwd) options.push("--chdir", cwd);
  return { mounts, options, net, writable, botId };
}

/** The bot's own folder (workspaces/<bot>) a turn has: its bot's, or the one its working folder is (a room's turn), never
 * a memory layer (a sibling folder, the turn's own). */
export function teamFolderOf(botId: string | null, cwd: string | null, dataDir: string): string | null {
  if (botId && ID.test(botId) && !isLayerId(botId)) return join(dataDir, "workspaces", botId);
  if (!cwd) return null;
  const [owner, ...rest] = relative(join(dataDir, "workspaces"), cwd).split(sep);
  return owner && ID.test(owner) && !isLayerId(owner) && !rest.includes("..") ? join(dataDir, "workspaces", owner) : null;
}

/** bubblewrap's argv for the plan (the command follows `--`). */
export function bwrapArgs(plan: BoxPlan): string[] {
  const args: string[] = [];
  for (const mount of plan.mounts) {
    switch (mount.kind) {
      case "ro": assertReadOnlySource(mount.source); args.push(mount.optional ? "--ro-bind-try" : "--ro-bind", mount.source, mount.target); break;
      case "bind": args.push(mount.optional ? "--bind-try" : "--bind", mount.source, mount.target); break;
      case "tmpfs": args.push("--tmpfs", mount.target); break;
      case "proc": args.push("--proc", mount.target); break;
      case "dev": args.push("--dev", mount.target); break;
      case "dir": args.push("--dir", mount.target); break;
      case "symlink": args.push("--symlink", mount.target, mount.link); break;
    }
  }
  args.push(...plan.options);
  return args;
}

/** Whether `path` is visible inside the box, by the plan alone: the last line that covers it decides. */
export function visibleInBox(plan: BoxPlan, path: string): "rw" | "ro" | "none" {
  const full = resolve(path);
  let verdict: "rw" | "ro" | "none" = "none";
  for (const mount of plan.mounts) {
    if (mount.kind === "symlink") continue;
    if (!under(full, mount.target)) continue;
    if (mount.kind === "bind") verdict = "rw";
    else if (mount.kind === "ro") verdict = "ro";
    else verdict = "none";
  }
  return verdict;
}

export function inBoxSocket(name: string): string {
  return join(IN_BOX_SOCKET_DIR, `${name}.sock`);
}
