// On POSIX, an ssh_config and an `ssh` shim give VPS docker commands connection sharing and fail-fast timeouts wherever the user's alias leaves them unset; the live-desktop tunnel opts out of sharing.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export const VPS_SSH_DIR = "ssh";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** macOS caps Unix socket paths at 104 bytes and OpenSSH appends a temporary suffix, so a long data path cannot host the socket. */
function controlDirectory(sshDir: string): string {
  if (Buffer.byteLength(join(sshDir, `cm-${"0".repeat(40)}`)) <= 80) return sshDir;
  const uid = process.getuid!();
  const id = createHash("sha256").update(resolve(sshDir)).digest("hex").slice(0, 12);
  // /tmp, not tmpdir(): macOS TMPDIR is often too long for a control socket. Validated first so a symlink or another user's dir cannot redirect it.
  const dir = `/tmp/omb-ssh-${uid}-${id}`;
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== uid) throw new Error("The VPS SSH control directory is not private to this user");
  chmodSync(dir, 0o700);
  return dir;
}

function findExecutable(name: string, pathValue: string, exclude: string): string | null {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir || dir === exclude) continue;
    const candidate = join(dir, name);
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {}
  }
  return null;
}

function writeIfChanged(path: string, content: string, mode: number): void {
  try { if (readFileSync(path, "utf8") === content) { chmodSync(path, mode); return; } } catch {}
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode });
  renameSync(temp, path);
}

/** ssh keeps the first value it sees, so the person's file goes first; -F skips the system file, so it goes last. */
export function vpsSshConfigText(sshDir: string, userConfig = join(homedir(), ".ssh", "config"), systemConfig = "/etc/ssh/ssh_config"): string {
  return [
    "# Written by OpenMausBot for its VPS computer connections. Do not edit;",
    "# it is regenerated. Your own ~/.ssh/config is included first and wins.",
    ...(existsSync(userConfig) ? [`Include ${JSON.stringify(userConfig)}`] : []),
    "Host *",
    "  ControlMaster auto",
    `  ControlPath ${JSON.stringify(join(sshDir.replace(/%/g, "%%"), "cm-%C"))}`,
    "  ControlPersist 10m",
    "  ServerAliveInterval 15",
    "  ServerAliveCountMax 3",
    "  ConnectTimeout 10",
    ...(existsSync(systemConfig) ? [`Include ${JSON.stringify(systemConfig)}`] : []),
    "",
  ].join("\n");
}

export interface VpsSshSetup {
  configPath: string | null;
  path: string;
}

/** Windows OpenSSH has no ControlMaster, so there nothing changes. */
export function prepareVpsSsh(dataDir: string, pathValue: string, platform: NodeJS.Platform = process.platform): VpsSshSetup {
  if (platform === "win32") return { configPath: null, path: pathValue };
  const sshDir = join(dataDir, VPS_SSH_DIR);
  const binDir = join(sshDir, "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  chmodSync(sshDir, 0o700);
  const configPath = join(sshDir, "config");
  writeIfChanged(configPath, vpsSshConfigText(controlDirectory(sshDir)), 0o600);
  const realSsh = findExecutable("ssh", pathValue, binDir);
  if (!realSsh) return { configPath, path: pathValue };
  const shim = [
    "#!/bin/sh",
    "# Written by OpenMausBot. docker's SSH transport finds this ssh first, so",
    "# docker commands share one connection unless the alias turns that off.",
    `exec ${shellQuote(realSsh)} -F ${shellQuote(configPath)} "$@"`,
    "",
  ].join("\n");
  writeIfChanged(join(binDir, "ssh"), shim, 0o700);
  return { configPath, path: `${binDir}${delimiter}${pathValue}` };
}
