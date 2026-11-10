// deploy/update-runner.sh, the Update server button's host side, against the stand-in for Docker that update.sh's own
// test drives (fake-compose-docker.mjs): the server's request in, root's copy of update.sh run, the outcome out. The
// requester is treated as hostile throughout: anything running as the server's user can leave the request.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
type Image = { id: string; refs: string[]; version: string; local: boolean; engine: boolean; serves?: string; behaviour?: string; lastWords?: string };
const OLD: Image = { id: id("a"), refs: [`${REPO}:latest`, `${REPO}@${id("1")}`], version: "0.1.150", local: true, engine: true };
const NEW: Image = { id: id("b"), refs: [`${REPO}@${id("2")}`, `${REPO}:v0.1.151`], version: "0.1.151", local: false, engine: true };
const NEXT: Image = { id: id("d"), refs: [`${REPO}@${id("4")}`, `${REPO}:v0.1.152`], version: "0.1.152", local: false, engine: true };
const OLDER: Image = { id: id("c"), refs: [`${REPO}@${id("3")}`, `${REPO}:v0.1.100`], version: "0.1.100", local: false, engine: true };
const EVIL = `${REPO}@${id("3")}`;
const EARLIER_COPY = "deploy_data-before-update-20261101T000000Z";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout's deploy/ folder running `running`, with root's folder as `--install` leaves it. */
function install(options: { stable?: Image; running?: Image; updater?: "real" | "recorder"; earlierCopy?: boolean } = {}) {
  const running = options.running ?? OLD;
  const stable = options.stable ?? NEW;
  const root = mkdtempSync(join(tmpdir(), "omb-update-runner-"));
  dirs.push(root);
  const deploy = join(root, "deploy");
  const state = join(root, "state");
  const fake = join(root, "fake");
  const bin = join(root, "bin");
  const data = join(fake, "volumes", "deploy_data");
  for (const dir of [bin, deploy, join(data, ".openmausbot"), join(state, "request"), join(state, "status")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(data, ".openmausbot", "bots.json"), '[{"name":"Mira"}]');
  writeFileSync(join(deploy, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(deploy, ".env"), "DOMAIN=maus.example.test\n");
  copyFileSync(join(DEPLOY, "update.sh"), join(deploy, "update.sh"));
  const argv = join(root, "update-sh-argv");
  if (options.updater === "recorder") writeFileSync(join(state, "update.sh"), `printf '%s\\n' "$#:$*:\${OMB_UPDATE_BY_RUNNER:-}" >> "${argv}"\n`);
  else copyFileSync(join(DEPLOY, "update.sh"), join(state, "update.sh"));
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const images = [running, stable, NEW, NEXT, OLDER].filter((image, at, all) => all.findIndex((other) => other.id === image.id) === at).map((image) => ({ ...image, local: image === running || image.local }));
  const labels: Record<string, string[]> = {};
  if (options.earlierCopy) {
    mkdirSync(join(fake, "volumes", EARLIER_COPY), { recursive: true });
    writeFileSync(join(fake, "volumes", EARLIER_COPY, "the-last-good-data.txt"), "good");
    labels[EARLIER_COPY] = ["com.mausbot.role=update-backup", "com.mausbot.project=deploy", "com.mausbot.data=deploy_data", `com.mausbot.image=${running.id}`];
  }
  writeFileSync(join(fake, "state.json"), JSON.stringify({
    serial: 1, composeReadsPin: true, defaultImage: `${REPO}:latest`, dataVolume: "deploy_data", images, volumeLabels: labels,
    containers: { omb: { id: "omb-1", image: running.id, status: "running", restarts: 0, started: "start-1" }, caddy: { id: "caddy-1", status: "running" } },
  }));
  const setStable = (image: Image) => writeFileSync(join(root, "stable.json"), JSON.stringify({ channel: "stable", version: image.version, image: image.refs.find((ref) => ref.includes("@sha256:")) }));
  setStable(stable);
  writeFileSync(join(state, "status", "runner"), `layout=compose\ndir=${deploy}\nheld=no\n`);
  writeFileSync(join(state, "status", "last"), "run=0\nstate=done\nresult=updated\nat=0\nran=0\n");
  const request = join(state, "request", "request");
  const policy = join(root, "policy.json");
  const run = (env: Record<string, string> = {}) => spawnSync("sh", [RUNNER], {
    encoding: "utf8", timeout: 60_000,
    env: {
      // The unit's own environment, as --install writes it, and nothing from the request.
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, FAKE_DOCKER_DIR: fake, OMB_INSTALL_DIR: deploy, OMB_UPDATE_STATE_DIR: state,
      OMB_UPDATE_POLICY: policy, OMB_STABLE_URL: `file://${join(root, "stable.json")}`, OMB_NEWEST_URL: `file://${join(root, "newest.json")}`,
      OMB_UPDATE_POLL_S: "0", OMB_UPDATE_WAIT_S: "120", OMB_UPDATE_ENGINE_WAIT_S: "1", OMB_RUNNER_QUIET_S: "0", ...env,
    },
  });
  const fakeState = () => JSON.parse(readFileSync(join(fake, "state.json"), "utf8"));
  const calls = () => (existsSync(join(fake, "calls.log")) ? readFileSync(join(fake, "calls.log"), "utf8").trim().split("\n") : []);
  return {
    root, deploy, state, fake, request, policy, run, setStable, calls, fakeState,
    ask: (env: Record<string, string> = {}) => {
      writeFileSync(request, "x\n");
      return run(env);
    },
    last: () => parseRun(readFileSync(join(state, "status", "last"), "utf8")),
    lastText: () => readFileSync(join(state, "status", "last"), "utf8"),
    runnerInfo: () => parseRunner(readFileSync(join(state, "status", "runner"), "utf8")),
    argv: () => (existsSync(argv) ? readFileSync(argv, "utf8").trim().split("\n") : []),
    env: () => readFileSync(join(deploy, ".env"), "utf8"),
    copies: () => Object.keys(fakeState().volumeLabels ?? {}).filter((name) => name.startsWith("deploy_data-before-update-")).sort(),
  };
}

/** What a server that wants more than "update now" might leave: flags, another image, an older version, a path. */
const GREEDY = `--rollback\n--allow-older\n--version 0.1.100\n--image ${EVIL}\nimage=${EVIL}\nversion=0.1.100\n--dir /etc\n$(touch /tmp/omb-pwned)\n`;

/** Root's tools without root: `id` says 0, `install` notes its owners and leaves them alone, `systemctl` notes what it is asked. */
function rootTools(root: string) {
  const fakes = join(root, "fakes");
  mkdirSync(fakes);
  const log = join(root, "root-tools.log");
  writeFileSync(join(fakes, "id"), "#!/bin/sh\necho 0\n");
  writeFileSync(join(fakes, "install"), `#!/bin/sh
echo "install $*" >> "${log}"
args=""
while [ $# -gt 0 ]; do case "$1" in -o|-g) shift ;; *) args="$args $1" ;; esac; shift; done
# shellcheck disable=SC2086
exec /usr/bin/install $args
`);
  writeFileSync(join(fakes, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${log}"\n`);
  for (const name of ["id", "install", "systemctl"]) chmodSync(join(fakes, name), 0o755);
  return { fakes, log: () => readFileSync(log, "utf8").trim().split("\n") };
}

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

  it("takes a request, runs root's copy of update.sh (stable, copy first) and writes how it ended", () => {
    const box = install();
    writeFileSync(box.request, "8d0c6a4e-0000-4000-8000-000000000000\n");
    const done = box.run();
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(existsSync(box.request)).toBe(false);
    expect(box.last()).toEqual({ run: 1, state: "done", result: "updated", at: expect.any(Number) });
    expect(box.fakeState().containers.omb).toMatchObject({ image: NEW.id, status: "running" });
    expect(box.env()).toContain(`OMB_IMAGE=${NEW.refs[0]}`);
    expect(box.calls().some((call) => call.includes("--entrypoint cp"))).toBe(true);
    expect(done.stdout).toContain("Updated from 0.1.150 to 0.1.151.");
  });

  it("runs the same update whatever the request says: no flag, image, version or path in it reaches update.sh", () => {
    const real = install();
    writeFileSync(real.request, GREEDY);
    expect(real.run().status).toBe(0);
    expect(real.last()?.result).toBe("updated");
    expect(real.fakeState().containers.omb.image).toBe(NEW.id);
    expect(real.calls().filter((call) => call.includes(EVIL) || call.includes("0.1.100"))).toEqual([]);
    expect(existsSync("/tmp/omb-pwned")).toBe(false);

    const recorded = install({ updater: "recorder" });
    writeFileSync(recorded.request, GREEDY);
    recorded.run();
    expect(recorded.argv()).toEqual([`2:--dir ${recorded.deploy}:1`]);
  });

  it("runs root's own copy of update.sh, never the one in the install's folder", () => {
    const box = install({ updater: "recorder" });
    writeFileSync(join(box.deploy, "update.sh"), `touch "${join(box.root, "ran-the-folder-copy")}"\n`);
    box.ask();
    expect(box.argv()).toHaveLength(1);
    expect(existsSync(join(box.root, "ran-the-folder-copy"))).toBe(false);
  });

  it("removes a request that is a link or a folder without following it", () => {
    const box = install({ updater: "recorder" });
    const victim = join(box.root, "precious.txt");
    writeFileSync(victim, "keep me");
    symlinkSync(victim, box.request);
    box.run();
    expect(() => lstatSync(box.request)).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(box.argv()).toEqual([`2:--dir ${box.deploy}:1`]);

    const folder = install({ updater: "recorder" });
    mkdirSync(join(folder.request, "nested"), { recursive: true });
    symlinkSync(victim, join(folder.request, "nested", "link"));
    folder.run();
    expect(existsSync(folder.request)).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("goes by the image's own label, never by the version the server says it runs", () => {
    // Newer than stable, claiming to be very old: asked for from the app, it is not "updated" down onto its newer data.
    const liar = install({ running: { ...NEXT, local: true, serves: "0.1.100" } });
    liar.ask();
    expect(liar.last()?.result).toBe("refused");
    expect(liar.fakeState().containers.omb.image).toBe(NEXT.id);
    expect(liar.copies()).toEqual([]);
    // Telling the truth, it is newer than stable, and nothing changes either.
    const newer = install({ running: { ...NEXT, local: true } });
    newer.ask();
    expect(newer.last()?.result).toBe("older");
    expect(newer.fakeState().containers.omb.image).toBe(NEXT.id);
    // A server that says it is newer than its image is not trusted for that either.
    const boaster = install({ running: { ...OLD, serves: "0.1.160" } });
    boaster.ask();
    expect(boaster.last()?.result).toBe("refused");
  });

  it("keeps every earlier copy of the data when the server asked: only a person's own run removes them", () => {
    const box = install({ earlierCopy: true });
    box.ask();
    expect(box.last()?.result).toBe("updated");
    expect(box.copies()).toEqual([EARLIER_COPY, expect.stringMatching(/^deploy_data-before-update-\d{8}T\d{6}Z/)]);
    expect(readFileSync(join(box.fake, "volumes", EARLIER_COPY, "the-last-good-data.txt"), "utf8")).toBe("good");
  });

  it("lets runs that change nothing pass freely, and keeps updates that change something four minutes apart", () => {
    const box = install({ stable: OLD });
    // A hostile requester's runs while there is nothing to update to: they stop nothing, and use up no gap.
    for (let at = 1; at <= 3; at += 1) {
      box.ask();
      expect(box.last()).toMatchObject({ run: at, result: "updated" });
    }
    expect(box.fakeState().containers.omb.id).toBe("omb-1");
    box.setStable(NEW);
    box.ask();
    expect(box.last()).toMatchObject({ run: 4, result: "updated" });
    expect(box.fakeState().containers.omb.image).toBe(NEW.id);
    // The run that changed something counts: the next one with something to change waits for the gap.
    box.setStable(NEXT);
    box.ask();
    expect(box.last()).toMatchObject({ run: 5, result: "too-soon" });
    expect(box.fakeState().containers.omb.image).toBe(NEW.id);
    box.ask({ OMB_RUNNER_GAP_S: "0" });
    expect(box.fakeState().containers.omb.image).toBe(NEXT.id);
  });

  it("spaces even cheap runs QUIET_S apart, waiting rather than refusing", () => {
    const box = install({ updater: "recorder" });
    box.ask({ OMB_RUNNER_QUIET_S: "2" });
    const started = Date.now();
    box.ask({ OMB_RUNNER_QUIET_S: "2", OMB_RUNNER_GAP_S: "0" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(box.argv()).toHaveLength(2);
  });

  it("puts the old version back when the new one is not healthy, and says so", () => {
    const box = install({ stable: { ...NEW, behaviour: "crashes", lastWords: "Error: cannot read the data" } });
    box.ask();
    expect(box.last()?.result).toBe("rolled-back");
    expect(box.fakeState().containers.omb).toMatchObject({ image: OLD.id, status: "running" });
  });

  it("does nothing while the owner's policy holds updates, and says the hold again whenever systemd runs it", () => {
    const box = install({ updater: "recorder" });
    writeFileSync(box.policy, '{ "jobs": ["status"], "updates" : "hold" }');
    box.run();
    expect(box.runnerInfo()).toMatchObject({ held: true });
    box.ask();
    expect(box.argv()).toEqual([]);
    expect(box.last()).toMatchObject({ run: 1, result: "held" });
    expect(existsSync(box.request)).toBe(false);
    writeFileSync(box.policy, "{}");
    box.run();
    expect(box.runnerInfo()).toMatchObject({ held: false });
  });

  it("says when root's folder has no update.sh", () => {
    const box = install({ updater: "recorder" });
    rmSync(join(box.state, "update.sh"));
    box.ask();
    expect(box.last()).toMatchObject({ run: 1, result: "no-updater" });
  });

  it("--install makes root's folder with the right owners and modes, copies update.sh into it, and --remove takes it all away", () => {
    const box = install();
    rmSync(box.state, { recursive: true });
    const tools = rootTools(box.root);
    const sbin = join(box.root, "sbin");
    const systemd = join(box.root, "systemd");
    mkdirSync(systemd);
    // The reviewer's attack: a temporary file planted as a link beside the override. Nothing is written through it.
    const victim = join(box.root, "victim.txt");
    writeFileSync(victim, "untouched");
    symlinkSync(victim, join(box.deploy, "docker-compose.override.yml.tmp"));
    const env = {
      PATH: `${tools.fakes}:${join(box.root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`, FAKE_DOCKER_DIR: box.fake, OMB_SBIN_DIR: sbin, OMB_SYSTEMD_DIR: systemd,
      OMB_UPDATE_STATE_DIR: box.state, OMB_UPDATE_POLICY: box.policy, OMB_STABLE_URL: "file:///srv/stable.json", OMB_UPDATE_WAIT_S: "300; rm -rf /",
      OMB_NEWEST_URL: "https://example.test/%2e%2e",
    };
    const done = spawnSync("sh", [RUNNER, "--install", "--dir", box.deploy, "--no-restart"], { encoding: "utf8", env, timeout: 30_000 });
    expect(done.status, done.stdout + done.stderr).toBe(0);
    // The request folder's owner is the data's owner on the host, never what the container says.
    const data = statSync(join(box.fake, "volumes", "deploy_data"));
    const owner = `${data.uid} -g ${data.gid}`;
    expect(tools.log()).toContain(`install -d -m 0755 -o 0 -g 0 ${box.state} ${join(box.state, "status")}`);
    expect(tools.log()).toContain(`install -d -m 0700 -o ${owner} ${join(box.state, "request")}`);
    expect(box.calls().some((call) => call.startsWith("compose exec"))).toBe(false);
    const mode = (path: string) => statSync(path).mode & 0o777;
    expect([mode(box.state), mode(join(box.state, "status")), mode(join(box.state, "request"))]).toEqual([0o755, 0o755, 0o700]);
    for (const file of ["runner", "last"]) expect(mode(join(box.state, "status", file)), file).toBe(0o644);
    expect(mode(join(box.state, "update.sh"))).toBe(0o755);
    expect(readFileSync(join(box.state, "update.sh"), "utf8")).toBe(readFileSync(join(DEPLOY, "update.sh"), "utf8"));
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(readFileSync(join(systemd, "openmausbot-update.path"), "utf8")).toContain(`PathExists=${box.state}/request/request\nPathChanged=${box.policy}\n`);
    const service = readFileSync(join(systemd, "openmausbot-update.service"), "utf8");
    expect(service).toContain(`ExecStart=${sbin}/openmausbot-update-runner`);
    // Root's settings at the install, and only plain values: one that is not is left out, `%` included (systemd expands it).
    expect(service).toContain(`Environment=HOME=/root OMB_INSTALL_DIR=${box.deploy} OMB_STABLE_URL=file:///srv/stable.json\n`);
    expect(readFileSync(join(sbin, "openmausbot-update-runner"), "utf8")).toBe(readFileSync(RUNNER, "utf8"));
    expect(tools.log()).toContain("systemctl enable --now openmausbot-update.path");
    expect(box.runnerInfo()).toEqual({ layout: "compose", dir: box.deploy, held: false });
    const override = readFileSync(join(box.deploy, "docker-compose.override.yml"), "utf8");
    expect(override).toContain(`- ${box.state}/request:/run/omb-update/request\n`);
    expect(override).toContain(`- ${box.state}/status:/run/omb-update/status:ro\n`);
    expect(readFileSync(join(box.deploy, "docker-compose.yml"), "utf8")).toBe("services: {}\n");

    const removed = spawnSync("sh", [RUNNER, "--remove", "--dir", box.deploy], { encoding: "utf8", env, timeout: 30_000 });
    expect(removed.status, removed.stdout + removed.stderr).toBe(0);
    for (const gone of [join(systemd, "openmausbot-update.path"), join(systemd, "openmausbot-update.service"), join(sbin, "openmausbot-update-runner"),
      join(box.deploy, "docker-compose.override.yml"), box.state]) expect(existsSync(gone), gone).toBe(false);
    expect(existsSync(join(box.deploy, "update.sh"))).toBe(true);
  });

  it("--install never writes through a link, and leaves an override of the person's own alone", () => {
    const box = install();
    const tools = rootTools(box.root);
    mkdirSync(join(box.root, "systemd"));
    const env = {
      PATH: `${tools.fakes}:/usr/bin:/bin:/usr/sbin:/sbin`, OMB_SBIN_DIR: join(box.root, "sbin"), OMB_SYSTEMD_DIR: join(box.root, "systemd"),
      OMB_UPDATE_STATE_DIR: box.state, OMB_UPDATE_POLICY: box.policy,
    };
    const installRunner = () => spawnSync("sh", [RUNNER, "--install", "--dir", box.deploy, "--user", "1000:1000", "--no-restart"], { encoding: "utf8", env, timeout: 30_000 });
    const victim = join(box.root, "victim.txt");
    writeFileSync(victim, "untouched");
    symlinkSync(victim, join(box.deploy, "docker-compose.override.yml"));
    const linked = installRunner();
    expect(linked.status).toBe(1);
    expect(linked.stderr).toContain("is a link, so it was left alone");
    expect(readFileSync(victim, "utf8")).toBe("untouched");

    rmSync(join(box.deploy, "docker-compose.override.yml"));
    writeFileSync(join(box.deploy, "docker-compose.override.yml"), "services:\n  omb:\n    environment:\n      MINE: 1\n");
    const mine = installRunner();
    expect(mine.status).toBe(1);
    expect(mine.stderr).toContain("is yours, so it was left alone");
    expect(mine.stderr).toContain(`- ${box.state}/request:/run/omb-update/request`);
    expect(readFileSync(join(box.deploy, "docker-compose.override.yml"), "utf8")).toContain("MINE: 1");
  });
});
