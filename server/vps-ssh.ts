// SSH connection sharing for the VPS computer, supplied by the app.
//
// Every VPS action is `docker -H ssh://alias …`, and the live desktop is an
// SSH port forward. Docker's SSH transport runs whatever `ssh` it finds on
// PATH with the user's own ~/.ssh/config, so without ControlMaster in that
// alias every command pays a full handshake — several hundred milliseconds
// each, on every preview frame and every click. The guide asks people to add
// the block; nothing checked, and the ones who missed it saw a computer that
// "connected but was slow". This module makes the alias irrelevant: a config
// that includes theirs first (so anything they set still wins) and fills in
// connection sharing and fail-fast timeouts, plus an `ssh` shim docker finds
// ahead of the real one that points at that config.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export const VPS_SSH_DIR = "ssh";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** macOS limits Unix socket paths to 104 bytes, including the terminator.
 * OpenSSH also appends a temporary suffix while creating a master socket.
 * A long application/test data path must not disable every SSH command. */
function controlDirectory(sshDir: string): string {
  if (Buffer.byteLength(join(sshDir, `cm-${"0".repeat(40)}`)) <= 80) return sshDir;
  const uid = process.getuid!();
  const id = createHash("sha256").update(resolve(sshDir)).digest("hex").slice(0, 12);
  // /tmp is intentionally used instead of tmpdir(): macOS TMPDIR is itself
  // often too long for a control socket. Validate before chmod or use so an
  // existing symlink/other user's directory cannot redirect the socket.
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
    } catch { /* keep looking */ }
  }
  return null;
}

function writeIfChanged(path: string, content: string, mode: number): void {
  try { if (readFileSync(path, "utf8") === content) { chmodSync(path, mode); return; } } catch { /* absent or unreadable: rewrite */ }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode });
  renameSync(temp, path);
}

/** The ssh_config the app hands to every VPS SSH connection. The person's own
 * file is included first: ssh keeps the first value it sees for an option, so
 * an alias that already sets ControlMaster or a timeout keeps its settings and
 * these lines only fill what it leaves unset. `-F` also skips the system file,
 * so that is included last for the same reason. */
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
  /** ssh_config to pass with -F, or null when the platform has no sharing. */
  configPath: string | null;
  /** PATH for a docker child: the shim directory first, when installed. */
  path: string;
}

/** Prepare the shared-connection config and the `ssh` shim under the data
 * directory, and return the PATH a docker or ssh child should run with.
 * Windows OpenSSH has no ControlMaster, so there everything stays as it was. */
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
    "# every VPS command shares one connection whether or not the alias says so.",
    `exec ${shellQuote(realSsh)} -F ${shellQuote(configPath)} "$@"`,
    "",
  ].join("\n");
  writeIfChanged(join(binDir, "ssh"), shim, 0o700);
  return { configPath, path: `${binDir}${delimiter}${pathValue}` };
}
