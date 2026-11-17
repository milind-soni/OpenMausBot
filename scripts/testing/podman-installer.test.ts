// deploy/podman/install.sh with stand-ins for Podman, its generator (quadlet), the user's systemd, loginctl and curl: which
// image it pins, which folder it keeps, what it refuses, and the unit it writes. The real thing runs in
// deploy/e2e/podman.sh on a CI runner.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "..", "deploy", "podman", "install.sh");
const REPO = "ghcr.io/milind-soni/openmausbot";
const DIGEST = `${REPO}@sha256:${"2".repeat(64)}`;
const STABLE = `${REPO}@sha256:${"5".repeat(64)}`;
const posix = process.platform !== "win32";
// The shell the one-line install runs in on Debian and Ubuntu.
const SHELL = existsSync("/bin/dash") ? "/bin/dash" : "/bin/sh";
const REAL_TOOLS = ["sed", "grep", "cat", "head", "tail", "mktemp", "chmod", "mv", "rm", "mkdir", "cut", "sh", "cp", "tr"];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Each stand-in logs its call to $FAKE/<name>.log and answers from FAKE_ settings and files in $FAKE. */
const STUBS: Record<string, string> = {
  uname: "echo Linux",
  id: 'case "$1" in -u) echo 1000 ;; -un) echo maus-tester ;; *) echo 1000 ;; esac',
  sleep: ":",
  ss: ":",
  loginctl: 'echo "${FAKE_LINGER:-yes}"',
  // version, rootless, pull, the image's digests and label, which images this machine has, and the image's user.
  podman: `case "$1 $2" in
  "version --format"*) echo 4.9.3 ;;
  "info --format"*) echo true ;;
  "pull -q") [ -z "\${FAKE_PULL_FAILS:-}" ] || { echo "Error: pull failed" >&2; exit 125; }; echo "$3" >>"$FAKE/pulled" ;;
  "image exists") grep -qx "$3" "$FAKE/local" 2>/dev/null ;;
  "image inspect")
    case "$4" in *RepoDigests*) printf '%s' "\${FAKE_DIGESTS-${DIGEST}}" | tr ' ' '\\n'; echo ;; *) echo v0.1.151 ;; esac ;;
  "run --rm") echo 1000 ;;
  *) echo "podman stand-in: $*" >&2; exit 64 ;;
esac`,
  // Podman's generator: what it was given, and the service it makes of it.
  quadlet: `cp "$QUADLET_UNIT_DIRS/openmausbot.container" "$FAKE/dryrun.container"; echo "$QUADLET_UNIT_DIRS" >"$FAKE/dryrun.dir"
[ -z "\${FAKE_QUADLET_FAILS:-}" ] || { echo "quadlet-generator[1]: converting \\"openmausbot.container\\": unsupported key 'HealthOnFailure'"; exit 0; }
echo "---openmausbot.service---"`,
  systemctl: `[ "$1" = --user ] || exit 64
case "$2" in
  show-environment | daemon-reload) ;;
  is-active) [ -f "$FAKE/active" ] ;;
  restart | start) : >"$FAKE/active" ;;
  stop) rm -f "$FAKE/active" ;;
  *) exit 64 ;;
esac`,
  // The stable channel (FAKE_STABLE_CODE, FAKE_STABLE_BODY), GitHub's newest release, update.sh's file, the health check.
  curl: `out=""; prev=""
for arg; do [ "$prev" = -o ] && out=$arg; prev=$arg; done
case "$*" in
  *channels/stable.json*) [ "\${FAKE_STABLE_CODE:-404}" = 000 ] && { printf 000; exit 7; }; printf '%s' "\${FAKE_STABLE_BODY:-}" >"$out"; printf '%s' "\${FAKE_STABLE_CODE:-404}" ;;
  *releases/latest*) printf '{"tag_name": "v0.1.151"}' ;;
  */deploy/update.sh*) echo "# the updater; it reads podman.unit" >"$out" ;;
  */api/health*) [ -f "$FAKE/active" ] && echo '{"app":"openmausbot"}' ;;
  *) exit 22 ;;
esac`,
};

function machine(options: { home?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omb-podman-install-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const fake = join(root, "fake");
  const home = join(root, options.home ?? "home");
  for (const dir of [bin, fake, home]) mkdirSync(dir, { recursive: true });
  for (const name of REAL_TOOLS) {
    const found = ["/usr/bin", "/bin"].map((folder) => join(folder, name)).find((path) => existsSync(path));
    if (found) symlinkSync(found, join(bin, name));
  }
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$*" >>"$FAKE/${name}.log"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const dir = join(home, ".local", "share", "openmausbot");
  const unitPath = join(home, ".config", "containers", "systemd", "openmausbot.container");
  const run = (args: string[] = [], env: Record<string, string> = {}) => {
    const result = spawnSync(SHELL, [SCRIPT, ...args], {
      encoding: "utf8", timeout: 30_000,
      env: { PATH: bin, HOME: home, XDG_RUNTIME_DIR: root, FAKE: fake, OMB_INSTALL_QUADLET: join(bin, "quadlet"), OMB_INSTALL_HEALTH_WAIT_S: "6", ...env },
    });
    return { ...result, out: result.stdout + result.stderr };
  };
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  const log = (name: string) => (read(join(fake, `${name}.log`)) ?? "").trim().split("\n").filter(Boolean);
  return {
    root, home, dir, fake, run, log, read,
    unit: () => read(unitPath),
    unitPath,
    pulled: () => (read(join(fake, "pulled")) ?? "").trim().split("\n").filter(Boolean),
    reset: () => { for (const name of ["pulled", "podman.log", "systemctl.log", "dryrun.dir"]) rmSync(join(fake, name), { force: true }); },
  };
}

describe.skipIf(!posix)("deploy/podman/install.sh", () => {
  it("parses in a POSIX shell and in dash", () => {
    expect(spawnSync("sh", ["-n", SCRIPT]).status).toBe(0);
    if (existsSync("/bin/dash")) expect(spawnSync("/bin/dash", ["-n", SCRIPT]).status).toBe(0);
  });

  it("installs the newest release while nothing is stable, pinned by digest, with a health check that reads the port when it runs", () => {
    const box = machine();
    const done = box.run(["--port", "8811"]);
    expect(done.status, done.out).toBe(0);
    expect(done.stdout).toContain("ok    version: v0.1.151, the newest release (no version is stable yet)");
    expect(box.pulled()).toEqual([`${REPO}:v0.1.151`]);
    const unit = box.unit()!;
    expect(unit).toContain(`Image=${DIGEST}\n`);
    // systemd turns $$ into $, so the container's shell reads OMB_PORT from server.env at each check.
    expect(unit).toContain("HealthCmd=curl -sf --max-time 4 http://127.0.0.1:$${OMB_PORT:-8799}/api/health | grep -q openmausbot\n");
    expect(unit).not.toContain("8811");
    expect(box.read(join(box.dir, "server.env"))).toContain("OMB_PORT=8811\n");
    expect(unit).toContain(`EnvironmentFile=${box.dir}/server.env\n`);
    expect(unit).toContain("Environment=OMB_PODMAN_SERVICE=~/.local/share/openmausbot\n");
    expect(unit).toContain("WARNING: this isolates less than the Docker install.");
    // The generator read a copy in a folder of its own, never the live unit's folder.
    expect(box.read(join(box.fake, "dryrun.container"))).toBe(unit);
    expect(box.read(join(box.fake, "dryrun.dir"))!.trim()).not.toBe(join(box.home, ".config", "containers", "systemd"));
    expect(box.read(join(box.dir, ".env"))).toBe(`OMB_IMAGE=${DIGEST}\n`);
    expect(done.stdout).toContain("MausBot is running as your user's service (openmausbot), on http://127.0.0.1:8811.");
    expect(done.stdout).toContain("Warning: it shares this machine's network, which isolates less than the Docker install.");
    expect(done.stdout).toContain("Bots run unboxed, beside the data folder that holds the engines' logins.");
    expect(done.stdout).toContain("Bots reach every service on this machine's loopback: databases, other programs' admin ports.");
    expect(done.stdout).toContain("Every account and program on this machine counts as the owner on port 8811, and can attach to Chrome's");
    expect(done.stdout).toContain("It starts at boot, without anyone logged in.");
  });

  it("speaks of the server's own port alone under --lan", () => {
    const box = machine();
    const done = box.run(["--lan"]);
    expect(done.status, done.out).toBe(0);
    expect(done.stdout).toContain("Its port 8799 also answers other devices on this network, from private addresses only, over plain http; each device pairs.");
    expect(done.stdout).not.toContain("nothing on the open internet can reach it");
  });

  it("takes the stable channel's image, and refuses a channel that fails or names no digest instead of falling back", () => {
    const stable = machine();
    const done = stable.run([], { FAKE_STABLE_CODE: "200", FAKE_STABLE_BODY: `{"channel": "stable", "version": "0.1.150", "image": "${STABLE}"}` });
    expect(done.status, done.out).toBe(0);
    expect(done.stdout).toContain("ok    version: the stable channel");
    expect(stable.pulled()).toEqual([STABLE]);
    expect(stable.unit()).toContain(`Image=${STABLE}\n`);

    for (const [env, words] of [
      [{ FAKE_STABLE_CODE: "500" }, "The stable channel could not be read (https://raw.githubusercontent.com/milind-soni/OpenMausBot/channels/stable.json answered 500)."],
      [{ FAKE_STABLE_CODE: "000" }, "answered 000"],
      [{ FAKE_STABLE_CODE: "200", FAKE_STABLE_BODY: `{"image": "${REPO}:stable"}` }, "names no image this installer accepts"],
    ] as const) {
      const box = machine();
      const refused = box.run([], env);
      expect(refused.status, refused.out).toBe(1);
      expect(refused.stderr).toContain(words);
      expect(box.pulled()).toEqual([]);
      expect(box.log("curl").some((call) => call.includes("releases/latest"))).toBe(false);
      expect(box.unit()).toBeNull();
      expect(existsSync(box.dir)).toBe(false);
    }
  });

  it("never keeps a tag it cannot pin by digest, and refuses the latest tag as the Docker installer does", () => {
    const box = machine();
    const unpinned = box.run([], { FAKE_DIGESTS: "" });
    expect(unpinned.status).toBe(1);
    expect(unpinned.stderr).toContain(`MausBot ${REPO}:v0.1.151 was downloaded, but Podman did not say its digest, so it cannot be pinned`);
    expect(box.unit()).toBeNull();
    expect(existsSync(join(box.dir, ".env"))).toBe(false);

    // A digest of another repository is not this image's.
    const other = machine().run([], { FAKE_DIGESTS: `docker.io/someone/else@sha256:${"9".repeat(64)}` });
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("cannot be pinned");

    for (const [image, words] of [
      [`${REPO}:latest`, "OMB_INSTALL_IMAGE names the latest tag, which follows every commit."],
      [REPO, "OMB_INSTALL_IMAGE needs a release tag"],
      [`${REPO}:v1;rm`, "OMB_INSTALL_IMAGE is not an image name."],
    ] as const) {
      const refused = machine();
      const result = refused.run([], { OMB_INSTALL_IMAGE: image });
      expect(result.status, image).toBe(1);
      expect(result.stderr).toContain(words);
      expect(refused.pulled()).toEqual([]);
    }

    const asked = machine();
    const pinned = asked.run([], { OMB_INSTALL_IMAGE: `${REPO}:v0.1.150` });
    expect(pinned.status, pinned.out).toBe(0);
    expect(asked.unit()).toContain(`Image=${DIGEST}\n`);
  });

  it("changes nothing while update.sh runs here, or after an update it did not finish", () => {
    const box = machine();
    expect(box.run().status).toBe(0);
    const unit = box.unit();
    const env = box.read(join(box.dir, ".env"));
    mkdirSync(join(box.dir, ".update", "lock"), { recursive: true });
    // This test's own process: alive for as long as the run.
    writeFileSync(join(box.dir, ".update", "lock", "pid"), `${process.pid}\n`);
    box.reset();
    for (const args of [["--lan"], ["--uninstall"]]) {
      const busy = box.run(args);
      expect(busy.status, args.join(" ")).toBe(1);
      expect(busy.stderr).toContain(`An update is running here (process ${process.pid}). Nothing was changed. Wait for ${box.dir}/update.sh to finish`);
    }
    expect(box.pulled()).toEqual([]);
    expect(box.log("systemctl")).toEqual([]);
    expect(box.unit()).toBe(unit);
    expect(box.read(join(box.dir, ".env"))).toBe(env);
    expect(box.read(join(box.dir, "server.env"))).not.toContain("OMB_LAN=1");

    // A lock its process left behind is no update.
    const gone = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(box.dir, ".update", "lock", "pid"), `${gone}\n`);
    writeFileSync(join(box.dir, ".update", "journal"), "phase=wait\n");
    const unfinished = box.run();
    expect(unfinished.status).toBe(1);
    expect(unfinished.stderr).toContain(`An update here did not finish (${box.dir}/.update/journal). Nothing was changed. Run ${box.dir}/update.sh first`);
    expect(box.unit()).toBe(unit);

    rmSync(join(box.dir, ".update", "journal"));
    const after = box.run();
    expect(after.status, after.out).toBe(0);
  });

  it("keeps the folder the service already uses when run again without --dir, and refuses a --dir that names another", () => {
    const box = machine();
    const elsewhere = join(box.root, "srv", "omb");
    expect(box.run(["--dir", elsewhere]).status).toBe(0);
    const unit = box.unit()!;
    expect(unit).toContain(`Volume=${elsewhere}/data:/data\n`);
    expect(unit).toContain(`Environment=OMB_PODMAN_SERVICE=${elsewhere}\n`);
    writeFileSync(join(elsewhere, "data", "bots.json"), "[]");

    const again = box.run(["--lan"]);
    expect(again.status, again.out).toBe(0);
    expect(again.stdout).toContain(`note  The service already uses ${elsewhere}, so this run does too (--dir names it).`);
    expect(box.unit()).toBe(unit);
    expect(box.read(join(elsewhere, "server.env"))).toContain("OMB_LAN=1\n");
    expect(existsSync(box.dir)).toBe(false);

    // The same folder, spelled with a trailing slash, is the same folder.
    expect(box.run(["--dir", `${elsewhere}/`]).status).toBe(0);

    const other = box.run(["--dir", join(box.root, "srv", "other")]);
    expect(other.status).toBe(1);
    expect(other.stderr).toContain(`This user's MausBot service already uses ${elsewhere}, and --dir names ${join(box.root, "srv", "other")}. Nothing was changed.`);
    expect(existsSync(join(box.root, "srv", "other"))).toBe(false);
    expect(box.unit()).toBe(unit);

    const refusedUninstall = box.run(["--uninstall", "--dir", join(box.root, "srv", "other")]);
    expect(refusedUninstall.status).toBe(1);
    expect(box.unit()).toBe(unit);

    const removed = box.run(["--uninstall"]);
    expect(removed.status, removed.out).toBe(0);
    expect(removed.stdout).toContain(`Your data stays in ${elsewhere}/data.`);
    expect(box.unit()).toBeNull();
    expect(existsSync(join(elsewhere, "podman.unit"))).toBe(false);
    expect(readFileSync(join(elsewhere, "data", "bots.json"), "utf8")).toBe("[]");
  });

  it("refuses a Docker install's folder", () => {
    for (const file of ["compose.yaml", "docker-compose.yml"]) {
      const box = machine();
      const docker = join(box.root, "opt", "openmausbot");
      mkdirSync(docker, { recursive: true });
      writeFileSync(join(docker, file), "services: {}\n");
      writeFileSync(join(docker, ".env"), "DOMAIN=maus.example.com\n");
      const refused = box.run(["--dir", docker]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(`${docker} holds a Docker install (compose.yaml or docker-compose.yml). Nothing was changed.`);
      expect(readFileSync(join(docker, ".env"), "utf8")).toBe("DOMAIN=maus.example.com\n");
      expect(box.unit()).toBeNull();
    }
  });

  it("leaves the unit in use and the settings as they were when Podman cannot read the new unit", () => {
    const box = machine();
    expect(box.run().status).toBe(0);
    const unit = box.unit();
    const settings = box.read(join(box.dir, "server.env"));
    box.reset();
    const failed = box.run(["--port", "8811"], { FAKE_QUADLET_FAILS: "1" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("Podman could not read the unit this would write, so nothing was changed: quadlet-generator[1]: converting");
    expect(box.unit()).toBe(unit);
    expect(box.read(join(box.dir, "server.env"))).toBe(settings);
    expect(box.log("systemctl").some((call) => call.includes("restart") || call.includes("daemon-reload"))).toBe(false);
  });

  it("installs in a home with @ in its name (realmd and SSSD homes), and names the folder when its characters cannot go in a unit", () => {
    const box = machine({ home: "home/maus@corp.example" });
    const done = box.run();
    expect(done.status, done.out).toBe(0);
    expect(box.unit()).toContain(`Volume=${box.dir}/data:/data\n`);

    const spaced = machine({ home: "home/maus tester" });
    const refused = spaced.run();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`The folder ${spaced.dir} has characters this installer does not write into a service's unit. Name another with --dir PATH`);
  });

  it("keeps the image a rollback named by this machine's own name, pinned by the digest it came with, and never pulls that name", () => {
    const box = machine();
    expect(box.run().status).toBe(0);
    const keep = "openmausbot-before-update:local";
    writeFileSync(join(box.dir, ".env"), `OMB_IMAGE=${keep}\n`);
    writeFileSync(join(box.fake, "local"), `${keep}\n`);
    box.reset();
    const again = box.run();
    expect(again.status, again.out).toBe(0);
    expect(again.stdout).toContain(`ok    version: the one already installed (${DIGEST}); update.sh changes it`);
    expect(box.pulled()).toEqual([DIGEST]);
    expect(box.unit()).toContain(`Image=${DIGEST}\n`);

    // An image of this machine's own that no registry knows: kept as it is, and said so.
    writeFileSync(join(box.dir, ".env"), `OMB_IMAGE=${keep}\n`);
    box.reset();
    const local = box.run([], { FAKE_DIGESTS: "" });
    expect(local.status, local.out).toBe(0);
    expect(local.stdout).toContain(`ok    version: the one already installed (${keep}, an image of this machine's own, not pinned by a digest); update.sh changes it`);
    expect(box.pulled()).toEqual([]);
    expect(box.unit()).toContain(`Image=${keep}\n`);
  });
});
