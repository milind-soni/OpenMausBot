// deploy/update.sh on a rootless Podman install (deploy/podman/install.sh): the server is the user's own systemd service
// from a Quadlet unit, so the update goes through Podman and `systemctl --user`, and the unit's Image= follows the pin.
// Podman, systemctl and journalctl are stand-ins over the Compose fake deploy-update.test.ts uses, with real folders for
// the data and its copy. The real thing runs in deploy/e2e/podman.sh.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "..", "deploy", "update.sh");
const FAKE = join(import.meta.dirname, "fake-compose-docker.mjs");
const REPO = "ghcr.io/milind-soni/openmausbot";
const posix = process.platform !== "win32";

const id = (letter: string) => `sha256:${letter.repeat(64)}`;
const OLD = { id: id("a"), refs: [`${REPO}:v0.1.150`, `${REPO}@${id("1")}`], version: "0.1.150", local: true, engine: true, counts: true };
const NEW = { id: id("b"), refs: [`${REPO}@${id("2")}`, `${REPO}:v0.1.151`], version: "0.1.151", local: false, engine: true, counts: true };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(files, tree(path, `${prefix}${name}/`));
    else files[`${prefix}${name}`] = readFileSync(path, "utf8");
  }
  return files;
}

const unitText = (image: string) => `[Container]\nContainerName=openmausbot\nImage=${image}\nNetwork=host\n\n[Service]\nRestart=on-failure\n`;

/** A Podman install on 0.1.150, its unit and settings as the installer writes them, and a stable channel naming `target`.
 * `extra`: the fake's own switches (failRestore); `old`: what the running version does when it is started again. */
function install(target: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, old: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "omb-update-podman-"));
  dirs.push(root);
  const home = join(root, "share", "openmausbot");
  const unit = join(root, "config", "containers", "systemd", "openmausbot.container");
  const fake = join(root, "fake");
  const data = join(fake, "volumes", "deploy_data");
  mkdirSync(join(root, "bin"));
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, "config", "containers", "systemd"), { recursive: true });
  mkdirSync(join(data, ".openmausbot"), { recursive: true });
  writeFileSync(join(data, ".openmausbot", "bots.json"), '[{"name":"Mira"}]');
  writeFileSync(join(data, "started-by.txt"), "0.1.150\n");
  copyFileSync(SCRIPT, join(home, "update.sh"));
  writeFileSync(join(home, ".env"), `OMB_IMAGE=${OLD.refs[1]}\n`, { mode: 0o600 });
  writeFileSync(join(home, "podman.unit"), `${unit}\n`);
  writeFileSync(unit, unitText(OLD.refs[1]!));
  const node = JSON.stringify(process.execPath);
  const shim = (name: string, body: string) => {
    writeFileSync(join(root, "bin", name), `#!/bin/sh\necho "$*" >>"$FAKE_DOCKER_DIR/${name}.log"\n${body}\n`);
    chmodSync(join(root, "bin", name), 0o755);
  };
  // Podman's own spelling of what the Compose fake answers: the unit's container by name, and exec without -T.
  shim("podman", [
    'case "$1" in',
    `  ps) exec ${node} "${FAKE}" compose ps -aq omb ;;`,
    `  exec) shift 2; exec ${node} "${FAKE}" compose exec -T omb "$@" ;;`,
    `  run) shift; [ "$1" = --security-opt ] && shift 2; exec ${node} "${FAKE}" run "$@" ;;`,
    `  compose) echo "a Podman install never runs compose" >&2; exit 64 ;;`,
    `  *) exec ${node} "${FAKE}" "$@" ;;`,
    "esac",
  ].join("\n"));
  // The user's systemd: restart starts the container from the unit's Image=, which is the only place it is read.
  shim("systemctl", [
    '[ "$1" = --user ] || { echo "only the user\'s own systemd" >&2; exit 64; }',
    "shift",
    'case "$1" in',
    "  show-environment | daemon-reload) exit 0 ;;",
    // stop-fails-on-new: the new version, once started, cannot be stopped (a rollback's stop fails).
    `  stop) if [ -f "$FAKE_DOCKER_DIR/stop-fails-on-new" ] && grep -qx "Image=${NEW.refs[0]}" "${unit}"; then echo "Failed to stop openmausbot.service" >&2; exit 1; fi; exec ${node} "${FAKE}" compose stop ;;`,
    `  restart) OMB_IMAGE=$(sed -n 's/^Image=//p' "${unit}") exec ${node} "${FAKE}" compose up -d ;;`,
    "esac",
    "exit 64",
  ].join("\n"));
  shim("journalctl", `exec ${node} "${FAKE}" compose logs`);
  // Linger on, as on a server; FAKE_LINGER=no for a user whose services stop at logout.
  shim("loginctl", '[ "$1" = show-user ] && echo "${FAKE_LINGER:-yes}"');
  writeFileSync(join(fake, "state.json"), JSON.stringify({
    ...extra, serial: 1, composeReadsPin: true, defaultImage: OLD.refs[1], dataVolume: "deploy_data", images: [{ ...OLD, ...old }, { ...NEW, ...target }],
    containers: { omb: { id: "omb-1", image: OLD.id, status: "running", restarts: 0 } },
  }));
  writeFileSync(join(root, "stable.json"), JSON.stringify({ channel: "stable", version: "0.1.151", image: NEW.refs[0], history: [] }));
  const run = (args: string[] = [], env: Record<string, string> = {}) => {
    const result = spawnSync("bash", [join(home, "update.sh"), ...args], {
      encoding: "utf8", input: "", timeout: 60_000,
      env: {
        PATH: `${join(root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, FAKE_DOCKER_DIR: fake, XDG_RUNTIME_DIR: root,
        OMB_STABLE_URL: `file://${join(root, "stable.json")}`, OMB_NEWEST_URL: `file://${join(root, "newest.json")}`,
        OMB_UPDATE_POLL_S: "0", OMB_UPDATE_WAIT_S: "120", OMB_UPDATE_ENGINE_WAIT_S: "1", ...env,
      },
    });
    return { ...result, said: result.stdout.trim().split("\n") };
  };
  const log = (name: string) => (existsSync(join(fake, `${name}.log`)) ? readFileSync(join(fake, `${name}.log`), "utf8").trim().split("\n") : []);
  const copies = () => readdirSync(join(fake, "volumes")).filter((name) => name.includes("-before-update-")).sort();
  return {
    data, run, log, copies, fake,
    state: () => JSON.parse(readFileSync(join(fake, "state.json"), "utf8")),
    env: () => readFileSync(join(home, ".env"), "utf8"),
    unit: () => readFileSync(unit, "utf8"),
  };
}

describe.skipIf(!posix)("deploy/update.sh on a Podman install", () => {
  it("copies the data aside, pins the new image in .env and in the unit, and restarts the user's service", () => {
    const box = install();
    const before = tree(box.data);
    const done = box.run();
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(box.copies()).toEqual([expect.stringMatching(/^openmausbot_data-before-update-\d{8}T\d{6}Z$/)]);
    expect(done.said).toEqual([
      "Downloading 0.1.151…",
      "Stopping the server and copying its data aside…",
      "Starting 0.1.151…",
      "Waiting for it to answer and to be able to start bots…",
      "Updated from 0.1.150 to 0.1.151.",
      `The data from before the update is kept in the Podman volume ${box.copies()[0]} until the next update.`,
      "To go back to it: ./update.sh --rollback",
    ]);
    expect(box.env()).toBe(`OMB_IMAGE=${NEW.refs[0]}\n`);
    expect(box.unit()).toBe(unitText(NEW.refs[0]!));
    expect(box.state().containers.omb).toMatchObject({ image: NEW.id, status: "running" });
    expect(tree(join(box.data, "..", box.copies()[0]!))).toEqual(before);
    const systemctl = box.log("systemctl");
    expect(systemctl.indexOf("--user stop openmausbot.service")).toBeGreaterThanOrEqual(0);
    expect(systemctl.indexOf("--user daemon-reload")).toBeLessThan(systemctl.indexOf("--user restart openmausbot.service"));
    // The helpers copy the data with SELinux's label for the server's container out of their way, and with no network.
    expect(box.log("podman").find((call) => call.includes("--entrypoint cp"))).toMatch(/^run --security-opt label=disable --rm --network none --user 0:0 /);
    expect(box.log("podman").some((call) => call.startsWith("compose"))).toBe(false);
  });

  it("puts back the old image in the unit, its settings and the data when the new version never answers", () => {
    const box = install({ behaviour: "silent" });
    const before = tree(box.data);
    const failed = box.run([], { OMB_UPDATE_WAIT_S: "2" });
    expect(failed.status).toBe(1);
    expect(failed.said.slice(-3)).toEqual([
      "The update to 0.1.151 did not work: it did not answer within 2 seconds.",
      "Putting back the version and the data from before the update…",
      "Your server runs 0.1.150 again, with its data as it was before the update.",
    ]);
    expect(box.env()).toBe(`OMB_IMAGE=${OLD.refs[1]}\n`);
    expect(box.unit()).toBe(unitText(OLD.refs[1]!));
    expect(box.state().containers.omb).toMatchObject({ image: OLD.id, status: "running" });
    expect(tree(box.data)).toEqual({ ...before, "started-by.txt": "0.1.150\n0.1.150\n" });
  });

  it("says why in the server's own words when the new version exits at once and Podman removes its container before it is looked at", () => {
    const box = install({ behaviour: "exits", lastWords: "broken on purpose" });
    const failed = box.run();
    expect(failed.status, failed.stdout + failed.stderr).toBe(1);
    expect(failed.said.slice(-3)).toEqual([
      "The update to 0.1.151 did not work: it stopped as it started (broken on purpose).",
      "Putting back the version and the data from before the update…",
      "Your server runs 0.1.150 again, with its data as it was before the update.",
    ]);
    expect(box.unit()).toBe(unitText(OLD.refs[1]!));
    expect(box.state().containers.omb).toMatchObject({ image: OLD.id, status: "running" });
  });

  it("says why in the server's own words when the new version's container stays listed but never answers a read", () => {
    const box = install({ behaviour: "uninspectable", lastWords: "broken on purpose" });
    const failed = box.run([], { OMB_UPDATE_WAIT_S: "2" });
    expect(failed.status, failed.stdout + failed.stderr).toBe(1);
    expect(failed.said.at(-3)).toBe("The update to 0.1.151 did not work: it stopped as it started (broken on purpose).");
    expect(box.unit()).toBe(unitText(OLD.refs[1]!));
  });

  it("names systemctl and journalctl, never docker compose, when a person has to step in", () => {
    // The data cannot be put back: the way to run the server on the data as it is.
    const restore = install({ behaviour: "silent" }, { failRestore: true });
    const failed = restore.run([], { OMB_UPDATE_WAIT_S: "2" });
    expect(failed.status).toBe(2);
    expect(failed.stdout).toContain("To run the server on the data as it is instead: systemctl --user start openmausbot (that starts 0.1.151 again).");
    expect(failed.stdout).not.toContain("docker compose");

    // The old version is back but does not become healthy either: its log.
    const unhealthy = install({ behaviour: "silent" }, {}, { behaviour: "crashes", lastWords: "the old one fails too" });
    const back = unhealthy.run([], { OMB_UPDATE_WAIT_S: "2" });
    expect(back.status).toBe(2);
    expect(back.said.at(-1)).toBe("0.1.150 and its data are back, but it did not become healthy either (it kept stopping as it started (the old one fails too)). See: journalctl --user -u openmausbot");

    // The new version cannot be stopped to roll back: the command to stop it.
    const stuck = install({ behaviour: "silent" });
    writeFileSync(join(stuck.fake, "stop-fails-on-new"), "");
    const kept = stuck.run([], { OMB_UPDATE_WAIT_S: "2" });
    expect(kept.status).toBe(2);
    expect(kept.said.at(-1)).toContain("run ./update.sh --rollback again once systemctl --user stop openmausbot works.");
  });

  it("says when the user's services stop at logout (linger off), and goes on", () => {
    const box = install();
    const done = box.run([], { FAKE_LINGER: "no" });
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(done.said[0]).toBe("Note: your user may not run services while logged out (linger is off), so the server stops when you log out and does not start at boot. Once, as an administrator: sudo loginctl enable-linger " + spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim());
    expect(done.said.at(-2)).toMatch(/^The data from before the update is kept in the Podman volume /);
  });

  it("refuses to run as root, whose Podman is not this install's", () => {
    if (process.getuid?.() !== 0) {
      const box = install();
      const id = join(dirs.at(-1)!, "bin", "id");
      writeFileSync(id, '#!/bin/sh\n[ "$1" = -u ] && echo 0 || exec /usr/bin/id "$@"\n');
      chmodSync(id, 0o755);
      const refused = box.run();
      expect(refused.status).toBe(4);
      expect(refused.stdout).toContain("run it as that user, without sudo");
      expect(box.log("systemctl")).toEqual([]);
    }
  });
});
