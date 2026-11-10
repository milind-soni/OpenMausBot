// deploy/update-runner.sh, the Update server button's host side, against the stand-in for Docker that update.sh's own
// test drives (fake-compose-docker.mjs): the server's request in, the standard update.sh run, the outcome out.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseRun, parseRunner } from "../../server/server-update.ts";

const DEPLOY = join(import.meta.dirname, "..", "..", "deploy");
const RUNNER = join(DEPLOY, "update-runner.sh");
const FAKE = join(import.meta.dirname, "fake-compose-docker.mjs");
const REPO = "ghcr.io/milind-soni/openmausbot";
const posix = process.platform !== "win32";

const id = (letter: string) => `sha256:${letter.repeat(64)}`;
const OLD = { id: id("a"), refs: [`${REPO}:latest`, `${REPO}@${id("1")}`], version: "0.1.150", local: true, engine: true };
const NEW = { id: id("b"), refs: [`${REPO}@${id("2")}`, `${REPO}:v0.1.151`], version: "0.1.151", local: false, engine: true };
const OLDER = { id: id("c"), refs: [`${REPO}@${id("3")}`, `${REPO}:v0.1.100`], version: "0.1.100", local: false, engine: true };
const EVIL = `${REPO}@${id("3")}`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout's deploy/ folder on 0.1.150, with the button's two folders as `--install` leaves them. */
function install(next: Record<string, unknown> = {}, options: { updater?: "real" | "recorder" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omb-update-runner-"));
  dirs.push(root);
  const deploy = join(root, "deploy");
  const fake = join(root, "fake");
  const bin = join(root, "bin");
  const data = join(fake, "volumes", "deploy_data");
  for (const dir of [bin, deploy, join(data, ".openmausbot"), join(deploy, "server-update", "request"), join(deploy, "server-update", "status")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(data, ".openmausbot", "bots.json"), '[{"name":"Mira"}]');
  writeFileSync(join(deploy, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(deploy, ".env"), "DOMAIN=maus.example.test\n");
  const argv = join(root, "update-sh-argv");
  if (options.updater === "recorder") {
    writeFileSync(join(deploy, "update.sh"), `printf '%s\\n' "$#:$*" >> "${argv}"\n`);
  } else {
    copyFileSync(join(DEPLOY, "update.sh"), join(deploy, "update.sh"));
  }
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const target = { ...NEW, ...next };
  writeFileSync(join(fake, "state.json"), JSON.stringify({
    serial: 1, composeReadsPin: true, defaultImage: `${REPO}:latest`, dataVolume: "deploy_data", images: [OLD, target, OLDER],
    containers: { omb: { id: "omb-1", image: OLD.id, status: "running", restarts: 0 }, caddy: { id: "caddy-1", status: "running" } },
  }));
  writeFileSync(join(root, "stable.json"), JSON.stringify({ channel: "stable", version: target.version, image: target.refs[0] }));
  const status = join(deploy, "server-update", "status");
  writeFileSync(join(status, "runner"), `layout=compose\ndir=${deploy}\nheld=no\n`);
  writeFileSync(join(status, "last"), "run=0\nstate=done\nresult=updated\nat=0\nran=0\n");
  const request = join(deploy, "server-update", "request", "request");
  const policy = join(root, "policy.json");
  const run = (env: Record<string, string> = {}) => spawnSync("sh", [RUNNER], {
    encoding: "utf8", timeout: 60_000,
    env: {
      // The unit's own environment, as --install writes it, and nothing from the request.
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, FAKE_DOCKER_DIR: fake, OMB_INSTALL_DIR: deploy, OMB_UPDATE_POLICY: policy,
      OMB_STABLE_URL: `file://${join(root, "stable.json")}`, OMB_NEWEST_URL: `file://${join(root, "newest.json")}`,
      OMB_UPDATE_POLL_S: "0", OMB_UPDATE_WAIT_S: next.behaviour === "silent" ? "2" : "120", OMB_UPDATE_ENGINE_WAIT_S: "1", ...env,
    },
  });
  const state = () => JSON.parse(readFileSync(join(fake, "state.json"), "utf8"));
  const calls = () => (existsSync(join(fake, "calls.log")) ? readFileSync(join(fake, "calls.log"), "utf8").trim().split("\n") : []);
  return {
    root, deploy, request, policy, run, state, calls,
    last: () => parseRun(readFileSync(join(status, "last"), "utf8")),
    lastText: () => readFileSync(join(status, "last"), "utf8"),
    argv: () => (existsSync(argv) ? readFileSync(argv, "utf8").trim().split("\n") : []),
    env: () => readFileSync(join(deploy, ".env"), "utf8"),
  };
}

/** What a server that wants more than "update now" might leave: flags, another image, an older version, a path. */
const GREEDY = `--rollback\n--allow-older\n--version 0.1.100\n--image ${EVIL}\nimage=${EVIL}\nversion=0.1.100\n--dir /etc\n$(touch /tmp/omb-pwned)\n`;

describe.skipIf(!posix)("deploy/update-runner.sh", () => {
  it("is plain POSIX sh", () => {
    expect(spawnSync("sh", ["-n", RUNNER]).status).toBe(0);
    const dash = spawnSync("dash", ["-n", RUNNER]);
    if (!dash.error) expect(dash.status).toBe(0);
  });

  it("does nothing without a request", () => {
    const box = install();
    expect(box.run().status).toBe(0);
    expect(box.calls()).toEqual([]);
    expect(box.lastText()).toBe("run=0\nstate=done\nresult=updated\nat=0\nran=0\n");
  });

  it("takes a request, runs the standard update (stable, copy first) and writes how it ended", () => {
    const box = install();
    writeFileSync(box.request, "8d0c6a4e-0000-4000-8000-000000000000\n");
    const done = box.run();
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(existsSync(box.request)).toBe(false);
    expect(box.last()).toEqual({ run: 1, state: "done", result: "updated", at: expect.any(Number) });
    expect(box.state().containers.omb).toMatchObject({ image: NEW.id, status: "running" });
    expect(box.env()).toContain(`OMB_IMAGE=${NEW.refs[0]}`);
    expect(box.calls().some((call) => call.includes("--entrypoint cp"))).toBe(true);
    expect(done.stdout).toContain("Updated from 0.1.150 to 0.1.151.");
  });

  it("runs the same update whatever the request says: no flag, image, version or path in it reaches update.sh", () => {
    const real = install();
    writeFileSync(real.request, GREEDY);
    expect(real.run().status).toBe(0);
    expect(real.last()?.result).toBe("updated");
    expect(real.state().containers.omb.image).toBe(NEW.id);
    expect(real.calls().filter((call) => call.includes(EVIL) || call.includes("0.1.100"))).toEqual([]);
    expect(existsSync("/tmp/omb-pwned")).toBe(false);

    const recorded = install({}, { updater: "recorder" });
    writeFileSync(recorded.request, GREEDY);
    recorded.run();
    expect(recorded.argv()).toEqual([`2:--dir ${recorded.deploy}`]);
  });

  it("removes a request that is a link or a folder without following it, and still runs only the standard update", () => {
    const box = install({}, { updater: "recorder" });
    const victim = join(box.root, "precious.txt");
    writeFileSync(victim, "keep me");
    symlinkSync(victim, box.request);
    box.run();
    expect(() => lstatSync(box.request)).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(box.argv()).toEqual([`2:--dir ${box.deploy}`]);

    const folder = install({}, { updater: "recorder" });
    mkdirSync(join(folder.request, "nested"), { recursive: true });
    symlinkSync(victim, join(folder.request, "nested", "link"));
    folder.run();
    expect(existsSync(folder.request)).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("puts the old version back when the new one is not healthy, and says so", () => {
    const box = install({ behaviour: "crashes", lastWords: "Error: cannot read the data" });
    writeFileSync(box.request, "x\n");
    expect(box.run().status).toBe(0);
    expect(box.last()?.result).toBe("rolled-back");
    expect(box.state().containers.omb).toMatchObject({ image: OLD.id, status: "running" });
  });

  it("runs no more often than its gap, and not at all while the owner's policy holds updates", () => {
    const box = install({}, { updater: "recorder" });
    writeFileSync(box.request, "x\n");
    box.run();
    writeFileSync(box.request, "x\n");
    box.run();
    expect(box.argv()).toHaveLength(1);
    expect(box.last()).toMatchObject({ run: 2, result: "too-soon" });
    writeFileSync(box.request, "x\n");
    box.run({ OMB_RUNNER_GAP_S: "0" });
    expect(box.argv()).toHaveLength(2);
    expect(box.last()).toMatchObject({ run: 3, result: "updated" });

    writeFileSync(box.policy, '{ "jobs": ["status"], "updates" : "hold" }');
    writeFileSync(box.request, "x\n");
    box.run({ OMB_RUNNER_GAP_S: "0" });
    expect(box.argv()).toHaveLength(2);
    expect(box.last()).toMatchObject({ run: 4, result: "held" });
    expect(existsSync(box.request)).toBe(false);
  });

  it("says when the install has no update.sh", () => {
    const box = install({}, { updater: "recorder" });
    rmSync(join(box.deploy, "update.sh"));
    writeFileSync(box.request, "x\n");
    box.run();
    expect(box.last()).toMatchObject({ run: 1, result: "no-updater" });
  });

  it("--install writes the two systemd units, the folders and the override; --remove takes them away", () => {
    const box = install();
    const sbin = join(box.root, "sbin");
    const systemd = join(box.root, "systemd");
    mkdirSync(systemd);
    const fakes = join(box.root, "fakes");
    mkdirSync(fakes);
    const log = join(box.root, "systemctl.log");
    // Root's tools, without root: `id` says 0, `install` leaves ownership alone, `systemctl` only notes what it is asked.
    writeFileSync(join(fakes, "id"), "#!/bin/sh\necho 0\n");
    writeFileSync(join(fakes, "install"), '#!/bin/sh\nargs=""\nwhile [ $# -gt 0 ]; do case "$1" in -o|-g) shift ;; *) args="$args $1" ;; esac; shift; done\n# shellcheck disable=SC2086\nexec /usr/bin/install $args\n');
    writeFileSync(join(fakes, "systemctl"), `#!/bin/sh\necho "$*" >> "${log}"\n`);
    for (const name of ["id", "install", "systemctl"]) chmodSync(join(fakes, name), 0o755);
    rmSync(join(box.deploy, "server-update"), { recursive: true });
    const env = {
      PATH: `${fakes}:${join(box.root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`, OMB_SBIN_DIR: sbin, OMB_SYSTEMD_DIR: systemd,
      OMB_UPDATE_POLICY: box.policy, OMB_STABLE_URL: "file:///srv/stable.json", OMB_UPDATE_WAIT_S: "300; rm -rf /",
    };
    const done = spawnSync("sh", [RUNNER, "--install", "--dir", box.deploy, "--user", "1000:1000", "--no-restart"], { encoding: "utf8", env, timeout: 30_000 });
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(readFileSync(join(systemd, "openmausbot-update.path"), "utf8")).toContain(`PathExists=${box.deploy}/server-update/request/request`);
    const service = readFileSync(join(systemd, "openmausbot-update.service"), "utf8");
    expect(service).toContain(`ExecStart=${sbin}/openmausbot-update-runner`);
    // Root's settings at the install, and only plain values: a value that is not one is left out.
    expect(service).toContain(`Environment=HOME=/root OMB_INSTALL_DIR=${box.deploy} OMB_STABLE_URL=file:///srv/stable.json\n`);
    expect(readFileSync(join(sbin, "openmausbot-update-runner"), "utf8")).toBe(readFileSync(RUNNER, "utf8"));
    expect(readFileSync(log, "utf8")).toContain("enable --now openmausbot-update.path");
    const status = join(box.deploy, "server-update", "status");
    expect(parseRunner(readFileSync(join(status, "runner"), "utf8"))).toEqual({ layout: "compose", dir: box.deploy, held: false });
    expect(parseRun(readFileSync(join(status, "last"), "utf8"))).toEqual({ run: 0, state: "done", result: "updated", at: 0 });
    const override = readFileSync(join(box.deploy, "docker-compose.override.yml"), "utf8");
    expect(override).toContain("- ./server-update/request:/run/omb-update/request\n");
    expect(override).toContain("- ./server-update/status:/run/omb-update/status:ro\n");
    expect(readFileSync(join(box.deploy, "docker-compose.yml"), "utf8")).toBe("services: {}\n");

    const removed = spawnSync("sh", [RUNNER, "--remove", "--dir", box.deploy], { encoding: "utf8", env, timeout: 30_000 });
    expect(removed.status, removed.stdout + removed.stderr).toBe(0);
    for (const gone of [join(systemd, "openmausbot-update.path"), join(systemd, "openmausbot-update.service"), join(sbin, "openmausbot-update-runner"),
      join(box.deploy, "docker-compose.override.yml"), join(box.deploy, "server-update")]) expect(existsSync(gone), gone).toBe(false);
    expect(existsSync(join(box.deploy, "update.sh"))).toBe(true);
  });

  it("--install leaves an override of the person's own alone, and says what to add", () => {
    const box = install();
    writeFileSync(join(box.deploy, "docker-compose.override.yml"), "services:\n  omb:\n    environment:\n      MINE: 1\n");
    const fakes = join(box.root, "fakes");
    mkdirSync(fakes);
    writeFileSync(join(fakes, "id"), "#!/bin/sh\necho 0\n");
    writeFileSync(join(fakes, "install"), '#!/bin/sh\nargs=""\nwhile [ $# -gt 0 ]; do case "$1" in -o|-g) shift ;; *) args="$args $1" ;; esac; shift; done\n# shellcheck disable=SC2086\nexec /usr/bin/install $args\n');
    writeFileSync(join(fakes, "systemctl"), "#!/bin/sh\n");
    for (const name of ["id", "install", "systemctl"]) chmodSync(join(fakes, name), 0o755);
    mkdirSync(join(box.root, "systemd"));
    const done = spawnSync("sh", [RUNNER, "--install", "--dir", box.deploy, "--user", "1000:1000", "--no-restart"], {
      encoding: "utf8", timeout: 30_000,
      env: { PATH: `${fakes}:/usr/bin:/bin:/usr/sbin:/sbin`, OMB_SBIN_DIR: join(box.root, "sbin"), OMB_SYSTEMD_DIR: join(box.root, "systemd"), OMB_UPDATE_POLICY: box.policy },
    });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain("is yours, so it was left alone");
    expect(done.stderr).toContain("- ./server-update/request:/run/omb-update/request");
    expect(readFileSync(join(box.deploy, "docker-compose.override.yml"), "utf8")).toContain("MINE: 1");
  });
});
