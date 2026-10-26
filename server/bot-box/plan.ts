// The bot box's plan: what one boxed process sees, as a list of mounts and the bubblewrap argv that makes it. Pure, so
// tests can check the list itself (and that removing a line opens exactly the hole it guards).
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
//     engines OpenMausBot installed there, whole, since npm's bin links point into the prefix by relative paths;
//   - a private /proc (its own PID namespace: other turns' processes do not exist for it), /dev, /tmp and /run;
//   - a network namespace with loopback only. Two loopback ports inside are bridged to unix sockets bound in from outside:
//     the egress gate (every connection to the internet goes through it) and the harness gate (only /api/internal/
//     routes of this server). Nothing else on the server's loopback is reachable.
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
  /** A Team Cloud audience's engine home, bound read-write in place of the server's HOME, none of which the box then has. */
  home?: string;
  /** Files bound read-write over their names in `home`: the team's engine sign-ins. */
  shared?: ReadonlyArray<{ source: string; target: string }>;
}

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

/** Absolute paths on the command line (`/x/y` or `--flag=/x/y`), which the engine must be able to read. */
export function argvPaths(args: readonly string[]): string[] {
  const paths: string[] = [];
  for (const arg of args) {
    const value = arg.startsWith("--") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    if (isAbsolute(value) && value.length > 1 && !paths.includes(value)) paths.push(resolve(value));
  }
  return paths;
}

/** Environment values that name folders the engine writes: its own config and caches. */
export const PATH_ENV_NAMES = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "GROK_HOME", "OPENCODE_HOME", "HERMES_HOME", "GEMINI_HOME", "TMPDIR"] as const;

/** Folders the box always has its own copy of, so no setting may put the host's back. */
const PRIVATE_INSIDE = ["/tmp", "/var/tmp", "/run", "/dev", "/proc"];

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
  if (cwd && !covered(cwd)) rw(cwd);
  if (botId && ID.test(botId)) {
    const own = join(dataDir, "workspaces", botId);
    if (!covered(own)) rw(own);
  }
  if (mutate.has("bind-otherws")) {
    rw(join(dataDir, "workspaces"));
    rw(join(dataDir, "task-workspaces"));
  }
  for (const name of PATH_ENV_NAMES) {
    const value = request.env[name];
    // A temp folder stays the box's own private one; anything else the engine writes is put back.
    if (value && isAbsolute(value) && !covered(resolve(value)) && !PRIVATE_INSIDE.some((base) => under(resolve(value), base))) rw(resolve(value));
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
  const readOnly = new Set<string>();
  for (const path of [...(request.ro ?? []), ...argvPaths(request.args)]) {
    const full = resolve(path);
    // Code and the system are already there; a file under HOME or /tmp the command line names is put back read-only.
    if (covered(full) || readOnly.has(full)) continue;
    if (["/usr", "/etc", "/opt", "/var/lib", ...setup.codeRoots, ...setup.engineRoots].some((base) => under(full, resolve(base)))) continue;
    readOnly.add(full);
    mounts.push({ kind: "ro", source: full, target: full, optional: true });
  }

  const options = ["--unshare-user", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--die-with-parent", "--hostname", BOX_HOSTNAME];
  if (!mutate.has("share-pid")) options.push("--unshare-pid");
  if (setup.seccompFd !== undefined && !mutate.has("no-seccomp")) options.push("--seccomp", String(setup.seccompFd));
  if (net === "isolated") {
    options.push("--unshare-net");
    mounts.push({ kind: "dir", target: IN_BOX_SOCKET_DIR });
    for (const bridge of setup.bridges) mounts.push({ kind: "bind", source: bridge.socket, target: join(IN_BOX_SOCKET_DIR, `${bridge.name}.sock`) });
  }
  if (cwd) options.push("--chdir", cwd);
  return { mounts, options, net, writable, botId };
}

/** bubblewrap's argv for the plan (the command follows `--`). */
export function bwrapArgs(plan: BoxPlan): string[] {
  const args: string[] = [];
  for (const mount of plan.mounts) {
    switch (mount.kind) {
      case "ro": args.push(mount.optional ? "--ro-bind-try" : "--ro-bind", mount.source, mount.target); break;
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
