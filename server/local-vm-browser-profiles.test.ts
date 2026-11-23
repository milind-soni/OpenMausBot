// The Local VM's website sign-ins live in browser profiles. These run the image's real start-up script and the real rescue
// against a fake home, workspace and container runtime, so "sign-ins survive replacing the desktop" is checked, not assumed.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { VM_WORKSPACE_GUEST, managedImageDockerfile, type LocalVmTarget } from "./container-computer.ts";
import { keepFirefoxProfileBeforeRemove, rescueFirefoxProfile, rescueInstalledApps } from "./local-vm-profiles.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-vm-profiles-"));
  temporary.push(dir);
  return dir;
};

/** The exact printf the image runs to write prepare-openmausbot-workspace.sh, pointed at a scratch workspace. */
function prepareScript(dir: string, workspace: string): string {
  const dockerfile = managedImageDockerfile();
  const end = dockerfile.indexOf("> /usr/local/bin/prepare-openmausbot-workspace.sh");
  const start = dockerfile.lastIndexOf("RUN printf", end);
  expect(start).toBeGreaterThan(-1);
  const script = join(dir, "prepare.sh");
  const bootId = join(dir, "boot-id");
  const initStat = join(dir, "init-stat");
  if (!existsSync(bootId)) {
    writeFileSync(bootId, "synthetic-boot");
    writeFileSync(initStat, ["1 (container init) S", ...Array(18).fill(0), 123, 0].join(" "));
  }
  const printf = dockerfile.slice(start + "RUN ".length, end).replaceAll(VM_WORKSPACE_GUEST, workspace)
    .replaceAll("/proc/sys/kernel/random/boot_id", bootId).replaceAll("/proc/1/stat", initStat);
  execFileSync("/bin/sh", ["-c", `${printf} > '${script}'`]);
  return script;
}

const runPrepare = (script: string, home: string) => execFileSync("/bin/sh", [script], { env: { PATH: process.env.PATH, HOME: home } });

const homeMigrations = [
  {
    label: "~/.config/google-chrome",
    base: "google-chrome",
    parent: (home: string) => join(home, ".config"),
    homePath: (home: string) => join(home, ".config", "google-chrome"),
    workspacePath: (workspace: string) => join(workspace, ".browser-profiles", "google-chrome"),
  },
  {
    label: "~/.config/chromium",
    base: "chromium",
    parent: (home: string) => join(home, ".config"),
    homePath: (home: string) => join(home, ".config", "chromium"),
    workspacePath: (workspace: string) => join(workspace, ".browser-profiles", "chromium"),
  },
  {
    label: "~/.mozilla",
    base: ".mozilla",
    parent: (home: string) => home,
    homePath: (home: string) => join(home, ".mozilla"),
    workspacePath: (workspace: string) => join(workspace, ".browser-profiles", "mozilla"),
  },
  {
    label: "~/.local",
    base: ".local",
    parent: (home: string) => home,
    homePath: (home: string) => join(home, ".local"),
    workspacePath: (workspace: string) => join(workspace, ".desktop-apps", "local"),
  },
] as const;

const recoveryDirectories = (parent: string, base: string) => readdirSync(parent)
  .filter((name) => name.startsWith(`unmerged-${base}-`))
  .sort();

const runPrepared = (script: string, home: string, path = process.env.PATH) => {
  const result = spawnSync("/bin/sh", [script], { encoding: "utf8", env: { PATH: path, HOME: home } });
  expect(result.status, result.stderr).toBe(0);
  return result.stderr;
};

function seedInterrupted(homePath: string, workspacePath: string) {
  mkdirSync(join(homePath, "nested"), { recursive: true });
  mkdirSync(join(homePath, "empty-dir"), { recursive: true });
  mkdirSync(join(homePath, "Local Storage"), { recursive: true });
  writeFileSync(join(homePath, "same.txt"), "same-bytes");
  writeFileSync(join(homePath, "nested", ".only-home"), "dotfile");
  writeFileSync(join(homePath, "Local Storage", "level.txt"), "spaced");
  writeFileSync(join(homePath, "..kept"), "dots");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(workspacePath, "same.txt"), "same-bytes");
  writeFileSync(join(workspacePath, "only-workspace.txt"), "workspace");
}

function bindMountsAvailable(): boolean {
  if (process.platform !== "linux") return false;
  const probe = mkdtempSync(join(tmpdir(), "omb-bind-probe-"));
  const from = join(probe, "from");
  const onto = join(probe, "onto");
  try {
    mkdirSync(from);
    mkdirSync(onto);
    writeFileSync(join(from, "marker"), "mounted");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const result = spawnSync("unshare", [
      "--user", "--map-root-user", "--mount",
      "/bin/sh", "-c",
      `mount --bind ${quote(from)} ${quote(onto)} && cat ${quote(join(onto, "marker"))}`,
    ], { encoding: "utf8", timeout: 5000 });
    return result.status === 0 && result.stdout.trim() === "mounted";
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

function fakeCommand(dir: string, name: string, body: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), body);
  chmodSync(join(bin, name), 0o755);
  return `${bin}:${process.env.PATH}`;
}

describe.skipIf(process.platform === "win32")("the image's start-up script keeps Firefox's profile in the workspace", () => {
  it("moves a first-run Firefox profile into the workspace and points ~/.mozilla at it", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    mkdirSync(join(home, ".mozilla", "firefox"), { recursive: true });
    writeFileSync(join(home, ".mozilla", "firefox", "profiles.ini"), "[Profile0]\nPath=abc.default-esr\n");
    mkdirSync(workspace);
    runPrepare(prepareScript(dir, workspace), home);
    const durable = join(workspace, ".browser-profiles", "mozilla");
    expect(lstatSync(join(home, ".mozilla")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, ".mozilla"))).toBe(durable);
    expect(readFileSync(join(durable, "firefox", "profiles.ini"), "utf8")).toContain("abc.default-esr");
    // Chrome and Chromium keep working as before.
    expect(readlinkSync(join(home, ".config", "google-chrome"))).toBe(join(workspace, ".browser-profiles", "google-chrome"));
    expect(readlinkSync(join(home, ".config", "chromium"))).toBe(join(workspace, ".browser-profiles", "chromium"));
    expect(readlinkSync(join(home, ".local"))).toBe(join(workspace, ".desktop-apps", "local"));
  });

  it("keeps a user-installed desktop app across a new VM image", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    mkdirSync(join(workspace, ".desktop-apps", "local", "share", "applications"), { recursive: true });
    writeFileSync(join(workspace, ".desktop-apps", "local", "share", "applications", "example.desktop"), "[Desktop Entry]");
    runPrepare(prepareScript(dir, workspace), home);
    expect(readFileSync(join(home, ".local", "share", "applications", "example.desktop"), "utf8")).toBe("[Desktop Entry]");
  });

  it("keeps a durable profile over the image's empty one and clears the old desktop's Firefox locks", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    // A new container: the image's own empty ~/.mozilla/firefox, and the profile rescued from the old desktop.
    mkdirSync(join(home, ".mozilla", "firefox"), { recursive: true });
    const profile = join(workspace, ".browser-profiles", "mozilla", "firefox", "abc.default-esr");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "cookies.sqlite"), "signed in");
    // Firefox's lock names the old container's address, so a new container would think another machine holds the profile.
    symlinkSync("172.17.0.5:+123", join(profile, "lock"));
    writeFileSync(join(profile, ".parentlock"), "");
    writeFileSync(join(profile, "lockfile.json"), "{}");
    runPrepare(prepareScript(dir, workspace), home);
    expect(readlinkSync(join(home, ".mozilla"))).toBe(join(workspace, ".browser-profiles", "mozilla"));
    expect(readFileSync(join(home, ".mozilla", "firefox", "abc.default-esr", "cookies.sqlite"), "utf8")).toBe("signed in");
    expect(existsSync(join(profile, ".parentlock"))).toBe(false);
    expect(() => lstatSync(join(profile, "lock"))).toThrow();
    expect(existsSync(join(profile, "lockfile.json"))).toBe(true);
    // A second start changes nothing.
    runPrepare(prepareScript(dir, workspace), home);
    expect(readFileSync(join(profile, "cookies.sqlite"), "utf8")).toBe("signed in");
  });

  it.each(["PID 1 start time", "boot ID"])("keeps live browser locks across a Cua driver restart until the %s changes", (identity) => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    const script = prepareScript(dir, workspace);
    runPrepare(script, home);
    const profiles = join(workspace, ".browser-profiles");
    const firefox = join(profiles, "mozilla", "firefox", "live.default-esr");
    mkdirSync(firefox, { recursive: true });
    const locks = [
      [join(profiles, "chromium", "SingletonLock"), `${hostname()}-${process.pid}`],
      [join(profiles, "chromium", "SingletonSocket"), "/tmp/synthetic-chromium-socket"],
      [join(profiles, "chromium", "SingletonCookie"), "synthetic-cookie"],
      [join(firefox, "lock"), `127.0.0.1:+${process.pid}`],
    ];
    for (const [lock, target] of locks) symlinkSync(target, lock);
    writeFileSync(join(firefox, ".parentlock"), "");

    runPrepare(script, home);

    for (const [lock, target] of locks) expect(readlinkSync(lock)).toBe(target);
    expect(existsSync(join(firefox, ".parentlock"))).toBe(true);

    if (identity === "boot ID") writeFileSync(join(dir, "boot-id"), "next-synthetic-boot");
    else writeFileSync(join(dir, "init-stat"), ["1 (container init) S", ...Array(18).fill(0), 456, 0].join(" "));
    runPrepare(script, home);
    for (const [lock] of locks) expect(() => lstatSync(lock)).toThrow();
    expect(existsSync(join(firefox, ".parentlock"))).toBe(false);
  });

  // An interrupted copy leaves the workspace non-empty and incomplete. The next start has to merge
  // the missing entries and only then replace the home directory.
  it.each(homeMigrations)("merges an interrupted copy of $label and keeps entries that were only at home", (migration) => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    mkdirSync(home);
    mkdirSync(workspace);
    const homePath = migration.homePath(home);
    const workspacePath = migration.workspacePath(workspace);
    seedInterrupted(homePath, workspacePath);
    const script = prepareScript(dir, workspace);
    const stderr = runPrepared(script, home);
    expect(lstatSync(homePath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(homePath)).toBe(workspacePath);
    expect(readFileSync(join(workspacePath, "same.txt"), "utf8")).toBe("same-bytes");
    expect(readFileSync(join(workspacePath, "nested", ".only-home"), "utf8")).toBe("dotfile");
    expect(readFileSync(join(workspacePath, "Local Storage", "level.txt"), "utf8")).toBe("spaced");
    expect(readFileSync(join(workspacePath, "..kept"), "utf8")).toBe("dots");
    expect(readFileSync(join(workspacePath, "only-workspace.txt"), "utf8")).toBe("workspace");
    expect(lstatSync(join(workspacePath, "empty-dir")).isDirectory()).toBe(true);
    expect(lstatSync(join(workspacePath, "empty-dir")).isSymbolicLink()).toBe(false);
    expect(readdirSync(join(workspacePath, "empty-dir"))).toEqual([]);
    expect(recoveryDirectories(migration.parent(home), migration.base)).toEqual([]);
    expect(stderr).not.toContain("preserved");
  });

  it.each(homeMigrations)("keeps a truncated $label file and the original tree, then leaves that recovery alone on the next start", (migration) => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    mkdirSync(home);
    mkdirSync(workspace);
    const homePath = migration.homePath(home);
    const workspacePath = migration.workspacePath(workspace);
    mkdirSync(join(homePath, "nested"), { recursive: true });
    writeFileSync(join(homePath, "cookies.sqlite"), "complete-secret");
    writeFileSync(join(homePath, "nested", ".only-home"), "dotfile");
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(workspacePath, "cookies.sqlite"), "partial");
    const script = prepareScript(dir, workspace);
    const stderr = runPrepared(script, home);
    expect(readFileSync(join(workspacePath, "cookies.sqlite"), "utf8")).toBe("partial");
    expect(readFileSync(join(workspacePath, "nested", ".only-home"), "utf8")).toBe("dotfile");
    const names = recoveryDirectories(migration.parent(home), migration.base);
    expect(names).toHaveLength(1);
    const held = join(migration.parent(home), names[0]!);
    expect(lstatSync(held).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(held, migration.base, "cookies.sqlite"), "utf8")).toBe("complete-secret");
    expect(readFileSync(join(held, migration.base, "nested", ".only-home"), "utf8")).toBe("dotfile");
    expect(stderr).toContain(`preserved ${homePath} at ${join(held, migration.base)}`);
    expect(stderr).toContain("container writable layer");
    expect(stderr).toContain("disappears when the container is replaced");
    const linkIno = lstatSync(homePath).ino;
    runPrepared(script, home);
    expect(lstatSync(homePath).ino).toBe(linkIno);
    expect(readlinkSync(homePath)).toBe(workspacePath);
    expect(recoveryDirectories(migration.parent(home), migration.base)).toEqual(names);
    expect(readFileSync(join(held, migration.base, "cookies.sqlite"), "utf8")).toBe("complete-secret");
    expect(readFileSync(join(workspacePath, "cookies.sqlite"), "utf8")).toBe("partial");
  });

  it.each(homeMigrations)("does not replace an already-correct $label link", (migration) => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    mkdirSync(migration.parent(home), { recursive: true });
    mkdirSync(workspace);
    const homePath = migration.homePath(home);
    symlinkSync(migration.workspacePath(workspace), homePath);
    const linkIno = lstatSync(homePath).ino;
    runPrepared(prepareScript(dir, workspace), home);
    expect(lstatSync(homePath).ino).toBe(linkIno);
    expect(readlinkSync(homePath)).toBe(migration.workspacePath(workspace));
  });

  it("preserves a top-level regular file instead of copying it into the workspace directory", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    mkdirSync(home);
    mkdirSync(workspace);
    writeFileSync(join(home, ".local"), "not-a-directory");
    runPrepared(prepareScript(dir, workspace), home);
    const [name] = recoveryDirectories(home, ".local");
    expect(name).toBeTruthy();
    expect(readFileSync(join(home, name!, ".local"), "utf8")).toBe("not-a-directory");
    expect(readlinkSync(join(home, ".local"))).toBe(join(workspace, ".desktop-apps", "local"));
    expect(readdirSync(join(workspace, ".desktop-apps", "local"))).toEqual([]);
  });

  it("moves a dangling home symlink aside as a symlink", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    mkdirSync(home);
    mkdirSync(workspace);
    const missing = join(dir, "missing-target");
    symlinkSync(missing, join(home, ".mozilla"));
    runPrepared(prepareScript(dir, workspace), home);
    const [name] = recoveryDirectories(home, ".mozilla");
    expect(lstatSync(join(home, name!, ".mozilla")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, name!, ".mozilla"))).toBe(missing);
    expect(readlinkSync(join(home, ".mozilla"))).toBe(join(workspace, ".browser-profiles", "mozilla"));
  });

  it("does not follow a destination symlink out of the workspace", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    const outside = join(dir, "outside");
    mkdirSync(join(home, ".local", "share"), { recursive: true });
    mkdirSync(outside);
    chmodSync(outside, 0o755);
    const outsideMode = lstatSync(outside).mode;
    const local = join(workspace, ".desktop-apps", "local");
    mkdirSync(local, { recursive: true });
    symlinkSync(outside, join(local, "share"));
    writeFileSync(join(home, ".local", "share", "secret.txt"), "leak");
    writeFileSync(join(home, ".local", "kept.txt"), "kept");
    runPrepared(prepareScript(dir, workspace), home);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(outside).mode).toBe(outsideMode);
    expect(readFileSync(join(local, "kept.txt"), "utf8")).toBe("kept");
    expect(readlinkSync(join(local, "share"))).toBe(outside);
    const [name] = recoveryDirectories(home, ".local");
    expect(readFileSync(join(home, name!, ".local", "share", "secret.txt"), "utf8")).toBe("leak");

    const redirected = scratch();
    const redirectedHome = join(redirected, "home");
    const redirectedWorkspace = join(redirected, "workspace");
    const redirectedOutside = join(redirected, "outside");
    mkdirSync(join(redirectedHome, ".mozilla"), { recursive: true });
    mkdirSync(join(redirectedWorkspace, ".browser-profiles"), { recursive: true });
    mkdirSync(redirectedOutside);
    chmodSync(redirectedOutside, 0o755);
    const redirectedMode = lstatSync(redirectedOutside).mode;
    symlinkSync(redirectedOutside, join(redirectedWorkspace, ".browser-profiles", "mozilla"));
    writeFileSync(join(redirectedHome, ".mozilla", "cookies.sqlite"), "secret");
    const result = spawnSync("/bin/sh", [prepareScript(redirected, redirectedWorkspace)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: redirectedHome },
    });
    expect(result.status).not.toBe(0);
    expect(readdirSync(redirectedOutside)).toEqual([]);
    expect(lstatSync(redirectedOutside).mode).toBe(redirectedMode);
    expect(lstatSync(join(redirectedHome, ".mozilla")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(redirectedHome, ".mozilla", "cookies.sqlite"), "utf8")).toBe("secret");
  });

  it("preserves the home tree when comparison fails", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    const local = join(workspace, ".desktop-apps", "local");
    mkdirSync(join(home, ".local"), { recursive: true });
    mkdirSync(local, { recursive: true });
    writeFileSync(join(home, ".local", "cookies.sqlite"), "same-bytes");
    writeFileSync(join(local, "cookies.sqlite"), "same-bytes");
    const path = fakeCommand(dir, "cmp", "#!/bin/sh\nexit 2\n");
    const stderr = runPrepared(prepareScript(dir, workspace), home, path);
    const [name] = recoveryDirectories(home, ".local");
    expect(readFileSync(join(home, name!, ".local", "cookies.sqlite"), "utf8")).toBe("same-bytes");
    expect(readFileSync(join(local, "cookies.sqlite"), "utf8")).toBe("same-bytes");
    expect(readlinkSync(join(home, ".local"))).toBe(local);
    expect(stderr).toContain("container writable layer");
  });

  it("leaves the home entry in place when the recovery rename fails", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    const local = join(workspace, ".desktop-apps", "local");
    mkdirSync(join(home, ".local"), { recursive: true });
    mkdirSync(local, { recursive: true });
    writeFileSync(join(home, ".local", "cookies.sqlite"), "complete");
    writeFileSync(join(home, ".local", "extra.txt"), "only-home");
    writeFileSync(join(local, "cookies.sqlite"), "partial");
    const path = fakeCommand(dir, "mv", "#!/bin/sh\nexit 1\n");
    const result = spawnSync("/bin/sh", [prepareScript(dir, workspace)], {
      encoding: "utf8",
      env: { PATH: path, HOME: home },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("leaving it in place");
    expect(lstatSync(join(home, ".local")).isDirectory()).toBe(true);
    expect(lstatSync(join(home, ".local")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(home, ".local", "cookies.sqlite"), "utf8")).toBe("complete");
    expect(readFileSync(join(home, ".local", "extra.txt"), "utf8")).toBe("only-home");
    expect(readFileSync(join(local, "cookies.sqlite"), "utf8")).toBe("partial");
    expect(readFileSync(join(local, "extra.txt"), "utf8")).toBe("only-home");
  });

  it("treats symlink targets that differ only by a trailing newline as different", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    const local = join(workspace, ".desktop-apps", "local");
    mkdirSync(join(home, ".local"), { recursive: true });
    mkdirSync(local, { recursive: true });
    symlinkSync("foo\n", join(home, ".local", "link"));
    symlinkSync("foo", join(local, "link"));
    runPrepared(prepareScript(dir, workspace), home);
    expect(readlinkSync(join(local, "link"))).toBe("foo");
    const [name] = recoveryDirectories(home, ".local");
    expect(readlinkSync(join(home, name!, ".local", "link"))).toBe("foo\n");

    const same = scratch();
    const sameHome = join(same, "home");
    const sameWorkspace = join(same, "workspace");
    const sameLocal = join(sameWorkspace, ".desktop-apps", "local");
    mkdirSync(join(sameHome, ".local"), { recursive: true });
    mkdirSync(sameLocal, { recursive: true });
    symlinkSync("foo\n", join(sameHome, ".local", "link"));
    symlinkSync("foo\n", join(sameLocal, "link"));
    runPrepared(prepareScript(same, sameWorkspace), sameHome);
    expect(recoveryDirectories(sameHome, ".local")).toEqual([]);
    expect(readlinkSync(join(sameLocal, "link"))).toBe("foo\n");
    expect(lstatSync(join(sameHome, ".local")).isSymbolicLink()).toBe(true);
  });

  it("does not delete browser profiles when ~/.config aliases the workspace profile directory", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    const profiles = join(workspace, ".browser-profiles");
    mkdirSync(home);
    mkdirSync(profiles, { recursive: true });
    symlinkSync(profiles, join(home, ".config"));
    const seeded = [
      [join(home, ".config", "google-chrome"), "chrome-bytes"],
      [join(home, ".config", "chromium"), "chromium-bytes"],
    ] as const;
    for (const [profile, bytes] of seeded) {
      mkdirSync(profile, { recursive: true });
      writeFileSync(join(profile, "Cookies"), bytes);
    }
    const before = seeded.map(([profile]) => lstatSync(profile).ino);
    const result = spawnSync("/bin/sh", [prepareScript(dir, workspace)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home },
    });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("resolve to the same directory");
    expect(result.stderr).toContain(join(home, ".config", "google-chrome"));
    expect(result.stderr).toContain(join(profiles, "google-chrome"));
    for (const [profile, bytes] of seeded) {
      const stat = lstatSync(profile);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isDirectory()).toBe(true);
      expect(readFileSync(join(profile, "Cookies"), "utf8")).toBe(bytes);
    }
    expect(before).toEqual(seeded.map(([profile]) => lstatSync(profile).ino));
    expect(lstatSync(join(home, ".config")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, ".config"))).toBe(profiles);
    expect(lstatSync(join(profiles, "google-chrome")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(profiles, "chromium")).isSymbolicLink()).toBe(false);
    expect(recoveryDirectories(profiles, "google-chrome")).toEqual([]);
    expect(recoveryDirectories(profiles, "chromium")).toEqual([]);
  });

  it("does not delete a profile nested inside its workspace copy", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    const target = join(workspace, ".browser-profiles", "google-chrome");
    mkdirSync(home);
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(home, ".config"));
    const cookies = join(target, "google-chrome", "google-chrome", "Cookies");
    mkdirSync(join(target, "google-chrome", "google-chrome"), { recursive: true });
    writeFileSync(cookies, "nested-bytes");
    const source = join(home, ".config", "google-chrome");
    const result = spawnSync("/bin/sh", [prepareScript(dir, workspace)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home },
    });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("one directory is inside the other");
    expect(result.stderr).toContain(source);
    expect(result.stderr).toContain(target);
    expect(readFileSync(cookies, "utf8")).toBe("nested-bytes");
    expect(existsSync(join(target, "google-chrome", "Cookies"))).toBe(false);
    expect(lstatSync(source).isSymbolicLink()).toBe(false);
    expect(lstatSync(source).isDirectory()).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(home, ".config")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, ".config"))).toBe(target);
    expect(recoveryDirectories(join(workspace, ".browser-profiles"), "google-chrome")).toEqual([]);
  });

  it("does not delete a profile when the workspace copy sits inside it", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const profileParent = join(dir, "profile-parent");
    const source = join(profileParent, "google-chrome");
    const workspace = join(source, "workspace");
    const target = join(workspace, ".browser-profiles", "google-chrome");
    mkdirSync(home);
    mkdirSync(target, { recursive: true });
    symlinkSync(profileParent, join(home, ".config"));
    writeFileSync(join(source, "Cookies"), "outer-bytes");
    const result = spawnSync("/bin/sh", [prepareScript(dir, workspace)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home },
    });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("one directory is inside the other");
    expect(result.stderr).toContain(join(home, ".config", "google-chrome"));
    expect(result.stderr).toContain(target);
    expect(readFileSync(join(source, "Cookies"), "utf8")).toBe("outer-bytes");
    expect(lstatSync(source).isSymbolicLink()).toBe(false);
    expect(lstatSync(source).isDirectory()).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(readlinkSync(join(home, ".config"))).toBe(profileParent);
    expect(recoveryDirectories(profileParent, "google-chrome")).toEqual([]);
  });

  const sameDirectoryAliases = [
    {
      label: "~/.local",
      leaf: ".local",
      workspaceParts: [".desktop-apps", "local"] as const,
    },
    {
      label: "~/.mozilla",
      leaf: ".mozilla",
      workspaceParts: [".browser-profiles", "mozilla"] as const,
    },
  ];
  const bindMounts = bindMountsAvailable();

  it.skipIf(!bindMounts).each(sameDirectoryAliases)(
    "does not delete $label when an aliased path resolves it to the workspace directory",
    (alias) => {
      const dir = scratch();
      const home = join(dir, "home");
      const workspace = join(dir, "workspace");
      const target = join(workspace, ...alias.workspaceParts);
      const source = join(home, alias.leaf);
      mkdirSync(home);
      mkdirSync(target, { recursive: true });
      mkdirSync(source);
      writeFileSync(join(target, "cookies.sqlite"), `${alias.leaf}-bytes`);
      const script = prepareScript(dir, workspace);
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const result = spawnSync("unshare", [
        "--user", "--map-root-user", "--mount",
        "/bin/sh", "-c",
        `mount --bind ${quote(target)} ${quote(source)} && exec /bin/sh ${quote(script)}`,
      ], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("resolve to the same directory");
      expect(result.stderr).toContain(source);
      expect(result.stderr).toContain(target);
      expect(readFileSync(join(target, "cookies.sqlite"), "utf8")).toBe(`${alias.leaf}-bytes`);
      const sourceStat = lstatSync(source);
      expect(sourceStat.isSymbolicLink()).toBe(false);
      expect(sourceStat.isDirectory()).toBe(true);
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      expect(recoveryDirectories(home, alias.leaf)).toEqual([]);
    },
  );

  it.each([
    ["prints nothing", "#!/bin/sh\nexit 0\n"],
    ["cannot stat", "#!/bin/sh\nexit 1\n"],
  ])("leaves ~/.local untouched when stat %s", (_label, body) => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    const local = join(workspace, ".desktop-apps", "local");
    mkdirSync(join(home, ".local"), { recursive: true });
    mkdirSync(local, { recursive: true });
    writeFileSync(join(home, ".local", "cookies.sqlite"), "home-secret");
    writeFileSync(join(local, "cookies.sqlite"), "workspace-secret");
    const path = fakeCommand(dir, "stat", body);
    const result = spawnSync("/bin/sh", [prepareScript(dir, workspace)], {
      encoding: "utf8",
      env: { PATH: path, HOME: home },
    });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain(`could not identify ${join(home, ".local")}`);
    expect(result.stderr).toContain("leaving it in place");
    expect(result.stderr).not.toContain("resolve to the same directory");
    expect(lstatSync(join(home, ".local")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(home, ".local")).isDirectory()).toBe(true);
    expect(readFileSync(join(home, ".local", "cookies.sqlite"), "utf8")).toBe("home-secret");
    expect(readFileSync(join(local, "cookies.sqlite"), "utf8")).toBe("workspace-secret");
    expect(existsSync(join(local, "only-home"))).toBe(false);
    expect(recoveryDirectories(home, ".local")).toEqual([]);
  });

  it("identifies a directory with stat -f when stat -c is unavailable", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    mkdirSync(join(home, ".local", "share"), { recursive: true });
    writeFileSync(join(home, ".local", "share", "apps.txt"), "kept");
    mkdirSync(workspace);
    const realStat = JSON.stringify(execFileSync("/bin/sh", ["-c", "command -v stat"], { encoding: "utf8" }).trim());
    const body = process.platform === "linux"
      ? `#!/bin/sh\nif [ "$1" = "-c" ]; then exit 1; fi\nexec ${realStat} -c "$2" -- "$4"\n`
      : `#!/bin/sh\nif [ "$1" = "-c" ]; then exit 1; fi\nexec ${realStat} "$@"\n`;
    const path = fakeCommand(dir, "stat", body);
    const stderr = runPrepared(prepareScript(dir, workspace), home, path);
    const local = join(workspace, ".desktop-apps", "local");
    expect(lstatSync(join(home, ".local")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, ".local"))).toBe(local);
    expect(readFileSync(join(local, "share", "apps.txt"), "utf8")).toBe("kept");
    expect(stderr).not.toContain("could not identify");
    expect(stderr).not.toContain("resolve to the same directory");
  });

  it("stops the driver wrapper when workspace preparation fails", () => {
    const dir = scratch();
    const prepare = join(dir, "prepare-fail.sh");
    writeFileSync(prepare, "#!/bin/sh\nexit 7\n");
    chmodSync(prepare, 0o755);
    const dockerfile = managedImageDockerfile();
    const marker = "> /usr/local/bin/start-openmausbot-cua-driver.sh";
    const end = dockerfile.indexOf(marker);
    const start = dockerfile.lastIndexOf("RUN printf", end);
    expect(start).toBeGreaterThan(-1);
    const wrapper = join(dir, "wrapper.sh");
    const printf = dockerfile.slice(start + "RUN ".length, end)
      .replaceAll("/usr/local/bin/prepare-openmausbot-workspace.sh", prepare);
    execFileSync("/bin/sh", ["-c", `${printf} > '${wrapper}'`]);
    const result = spawnSync("/bin/sh", [wrapper], { encoding: "utf8", timeout: 3000 });
    expect(result.status).toBe(7);
    expect(result.stderr ?? "").not.toContain("did not become ready");
  });
});

/** A container runtime whose `cp` copies out of a fixture "container" tree, as docker cp does for a stopped container. */
function fakeRuntime(dir: string, container: string, opts: { fail?: string } = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "runtime.log");
  const runtime = join(bin, "docker");
  writeFileSync(runtime, `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
[ "$1" = cp ] || { echo "unexpected: $*" >&2; exit 64; }
${opts.fail ? `echo '${opts.fail}' >&2; exit 1` : ""}
src="\${2#*:}"
[ -e "${container}$src" ] || [ -L "${container}$src" ] || { echo "Error response from daemon: Could not find the file $src in container omb" >&2; exit 1; }
[ -e "$3" ] && { echo "destination exists" >&2; exit 1; }
cp -RP "${container}$src" "$3"
`);
  chmodSync(runtime, 0o755);
  return { runtime, log };
}

const target = (workspaceDir: string): LocalVmTarget => ({ key: "bot:x", containerName: "openmausbot-computer-x", workspaceDir, viewerPort: null, label: "x" });

describe.skipIf(process.platform === "win32")("rescueFirefoxProfile", () => {
  it("copies user-installed desktop apps into the durable area before replacement", async () => {
    const dir = scratch();
    const container = join(dir, "container");
    mkdirSync(join(container, "home", "cua", ".local", "share", "applications"), { recursive: true });
    writeFileSync(join(container, "home", "cua", ".local", "share", "applications", "example.desktop"), "[Desktop Entry]");
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    expect(await rescueInstalledApps(fakeRuntime(dir, container).runtime, target(workspace))).toBe("rescued");
    expect(readFileSync(join(workspace, ".desktop-apps", "local", "share", "applications", "example.desktop"), "utf8")).toBe("[Desktop Entry]");
  });

  it("refuses to replace a different durable app area", async () => {
    const dir = scratch();
    const container = join(dir, "container");
    mkdirSync(join(container, "home", "cua", ".local", "share", "applications"), { recursive: true });
    writeFileSync(join(container, "home", "cua", ".local", "share", "applications", "example.desktop"), "old desktop");
    const workspace = join(dir, "workspace");
    mkdirSync(join(workspace, ".desktop-apps", "local", "share", "applications"), { recursive: true });
    const durable = join(workspace, ".desktop-apps", "local", "share", "applications", "example.desktop");
    writeFileSync(durable, "durable desktop");

    await expect(rescueInstalledApps(fakeRuntime(dir, container).runtime, target(workspace)))
      .rejects.toThrow(/durable app area differs/);
    expect(readFileSync(durable, "utf8")).toBe("durable desktop");
  });
  it("copies an old desktop's Firefox profile into the workspace before the desktop is removed", async () => {
    const dir = scratch();
    const container = join(dir, "container");
    mkdirSync(join(container, "home", "cua", ".mozilla", "firefox", "abc.default-esr"), { recursive: true });
    writeFileSync(join(container, "home", "cua", ".mozilla", "firefox", "abc.default-esr", "cookies.sqlite"), "signed in");
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const { runtime, log } = fakeRuntime(dir, container);
    expect(await rescueFirefoxProfile(runtime, target(workspace))).toBe("rescued");
    expect(readFileSync(join(workspace, ".browser-profiles", "mozilla", "firefox", "abc.default-esr", "cookies.sqlite"), "utf8")).toBe("signed in");
    const [copy] = readFileSync(log, "utf8").trim().split("\n");
    expect(copy).toMatch(/^cp openmausbot-computer-x:\/home\/cua\/\.mozilla \S+\/\.mozilla-rescue-[0-9a-f]+$/);
    expect(copy.startsWith(`cp openmausbot-computer-x:/home/cua/.mozilla ${workspace}/.mozilla-rescue-`)).toBe(true);
    expect(readdirSync(join(workspace, ".browser-profiles"))).toEqual(["mozilla"]);
    expect(readdirSync(workspace)).toEqual([".browser-profiles"]);
  });

  it("never overwrites a profile already in the workspace, and leaves a desktop whose ~/.mozilla is already a link alone", async () => {
    const dir = scratch();
    const container = join(dir, "container");
    mkdirSync(join(container, "home", "cua"), { recursive: true });
    symlinkSync("/home/cua/workspace/.browser-profiles/mozilla", join(container, "home", "cua", ".mozilla"));
    const workspace = join(dir, "workspace");
    const { runtime } = fakeRuntime(dir, container);
    mkdirSync(workspace);
    expect(await rescueFirefoxProfile(runtime, target(workspace))).toBe("none");
    expect(existsSync(join(workspace, ".browser-profiles", "mozilla"))).toBe(false);
    expect(readdirSync(join(workspace, ".browser-profiles"))).toEqual([]);
    mkdirSync(join(workspace, ".browser-profiles", "mozilla", "firefox"), { recursive: true });
    writeFileSync(join(workspace, ".browser-profiles", "mozilla", "firefox", "profiles.ini"), "kept");
    expect(await rescueFirefoxProfile(runtime, target(workspace))).toBe("kept");
    expect(readFileSync(join(workspace, ".browser-profiles", "mozilla", "firefox", "profiles.ini"), "utf8")).toBe("kept");
  });

  it("reports a desktop that never ran Firefox as nothing to rescue, and fails loudly on any other copy error", async () => {
    const dir = scratch();
    const container = join(dir, "container");
    mkdirSync(join(container, "home", "cua"), { recursive: true });
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    expect(await rescueFirefoxProfile(fakeRuntime(dir, container).runtime, target(workspace))).toBe("none");
    const broken = scratch();
    await expect(rescueFirefoxProfile(fakeRuntime(broken, container, { fail: "permission denied" }).runtime, target(workspace)))
      .rejects.toThrow(/permission denied/);
    expect(readdirSync(join(workspace, ".browser-profiles"))).toEqual([]);
  });

  // A desktop from before cua took the host's ids (uid 1000) leaves these folders owned by that uid; the server cannot
  // write in them, yet a desktop whose ~/.mozilla and ~/.local already link into the workspace has nothing to copy.
  it.skipIf(process.getuid?.() === 0)("updates a desktop whose profile folders an older desktop owns when there is nothing to copy", async () => {
    const dir = scratch();
    const container = join(dir, "container");
    mkdirSync(join(container, "home", "cua"), { recursive: true });
    symlinkSync("/home/cua/workspace/.browser-profiles/mozilla", join(container, "home", "cua", ".mozilla"));
    symlinkSync("/home/cua/workspace/.desktop-apps/local", join(container, "home", "cua", ".local"));
    const workspace = join(dir, "workspace");
    mkdirSync(join(workspace, ".browser-profiles"), { recursive: true });
    mkdirSync(join(workspace, ".desktop-apps", "local", "share"), { recursive: true });
    chmodSync(join(workspace, ".browser-profiles"), 0o500);
    chmodSync(join(workspace, ".desktop-apps"), 0o500);
    try {
      const { runtime } = fakeRuntime(dir, container);
      expect(await rescueFirefoxProfile(runtime, target(workspace))).toBe("none");
      expect(await rescueInstalledApps(runtime, target(workspace))).toBe("none");
    } finally {
      chmodSync(join(workspace, ".browser-profiles"), 0o700);
      chmodSync(join(workspace, ".desktop-apps"), 0o700);
    }
    expect(readdirSync(workspace).sort()).toEqual([".browser-profiles", ".desktop-apps"]);
  });

  it.skipIf(process.getuid?.() === 0)("names the command that hands an older desktop's folders back when it must write in them", async () => {
    const dir = scratch();
    const container = join(dir, "container");
    mkdirSync(join(container, "home", "cua", ".mozilla", "firefox"), { recursive: true });
    writeFileSync(join(container, "home", "cua", ".mozilla", "firefox", "profiles.ini"), "old desktop");
    // An apostrophe in the path must still give a command the shell runs as written.
    const workspace = join(dir, "o'brien workspace");
    mkdirSync(join(workspace, ".browser-profiles"), { recursive: true });
    chmodSync(join(workspace, ".browser-profiles"), 0o500);
    // The fake runtime is a path; the update itself only ever passes "docker" or "podman" through to the same spawn.
    const status = { runtime: fakeRuntime(dir, container).runtime as "docker", container: "stopped", managed: true, imageMatches: false } as const;
    let failure: unknown;
    try {
      failure = await keepFirefoxProfileBeforeRemove(target(workspace), status, async () => {}).catch((error: unknown) => error);
    } finally {
      chmodSync(join(workspace, ".browser-profiles"), 0o700);
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`sudo chown -R ${process.getuid?.()}:${process.getgid?.()} '${workspace.replaceAll("'", "'\\''")}' and`);
    expect(readdirSync(workspace)).toEqual([".browser-profiles"]);
  });
});
