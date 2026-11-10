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
const OLD = { id: id("a"), refs: [`${REPO}:latest`, `${REPO}@${id("1")}`], version: "0.1.150", local: true, engine: true };
const NEW = { id: id("b"), refs: [`${REPO}@${id("2")}`, `${REPO}:v0.1.151`], version: "0.1.151", local: false, engine: true };
const ENV = "DOMAIN=maus.example.test\nOMB_SIGNIN_EMAILS=owner@example.test\n";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every file under `dir` with its content: what "the data as it was" means. */
function tree(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(files, tree(path, `${prefix}${name}/`));
    else files[`${prefix}${name}`] = readFileSync(path, "utf8");
  }
  return files;
}

/** A Compose install on version 0.1.150 with some data, and a stable channel that names `target`. */
function install(target: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "omb-update-"));
  dirs.push(root);
  const deploy = join(root, "deploy");
  const fake = join(root, "fake");
  const data = join(fake, "volumes", "deploy_data");
  mkdirSync(join(root, "bin"));
  mkdirSync(deploy);
  mkdirSync(join(data, ".openmausbot"), { recursive: true });
  writeFileSync(join(data, ".openmausbot", "bots.json"), '[{"name":"Mira"}]');
  writeFileSync(join(data, "started-by.txt"), "0.1.150\n");
  copyFileSync(SCRIPT, join(deploy, "update.sh"));
  writeFileSync(join(deploy, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(deploy, ".env"), ENV);
  writeFileSync(join(root, "bin", "docker"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(root, "bin", "docker"), 0o755);
  const next = { ...NEW, ...target };
  // A version that never answers is waited for; two seconds of that is enough here.
  const wait = next.behaviour === "silent" ? { OMB_UPDATE_WAIT_S: "2" } : {};
  writeFileSync(join(fake, "state.json"), JSON.stringify({
    serial: 1, composeReadsPin: true, defaultImage: `${REPO}:latest`, dataVolume: "deploy_data", images: [OLD, next],
    containers: { omb: { id: "omb-1", image: OLD.id, status: "running", restarts: 0 }, caddy: { id: "caddy-1", status: "running" } },
    ...extra,
  }));
  writeFileSync(join(root, "stable.json"), JSON.stringify({ channel: "stable", version: next.version, image: next.refs[0], history: [{ version: next.version, promotedAt: "2026-11-10T00:00:00Z" }] }, null, 2));
  const state = () => JSON.parse(readFileSync(join(fake, "state.json"), "utf8"));
  const run = (args: string[] = [], options: { input?: string; env?: Record<string, string> } = {}) => {
    const result = spawnSync("bash", [join(deploy, "update.sh"), ...args], {
      encoding: "utf8", input: options.input ?? "", timeout: 60_000,
      env: {
        PATH: `${join(root, "bin")}:/usr/bin:/bin`, HOME: root, FAKE_DOCKER_DIR: fake, OMB_STABLE_URL: `file://${join(root, "stable.json")}`,
        OMB_UPDATE_POLL_S: "0", OMB_UPDATE_WAIT_S: "120", ...wait, ...options.env,
      },
    });
    return { ...result, said: result.stdout.trim().split("\n") };
  };
  const calls = () => (existsSync(join(fake, "calls.log")) ? readFileSync(join(fake, "calls.log"), "utf8").trim().split("\n") : []);
  return {
    root, deploy, fake, data, state, run, calls,
    setState: (patch: Record<string, unknown>) => writeFileSync(join(fake, "state.json"), JSON.stringify({ ...state(), ...patch })),
    env: () => readFileSync(join(deploy, ".env"), "utf8"),
    backup: () => join(fake, "volumes", "deploy_data-before-update"),
    journal: () => existsSync(join(deploy, ".update", "journal")),
  };
}

describe.skipIf(!posix)("deploy/update.sh", () => {
  it("is valid bash", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });

  it("copies the data aside, pins the stable image by digest, and waits until the new version answers and can start bots", () => {
    const box = install();
    const before = tree(box.data);
    const done = box.run();
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(done.said).toEqual([
      "Downloading 0.1.151…",
      "Stopping the server and copying its data aside…",
      "Starting 0.1.151…",
      "Waiting for it to answer and to be able to start bots…",
      "Updated from 0.1.150 to 0.1.151.",
      "The data from before the update is kept in the Docker volume deploy_data-before-update until the next update.",
      "To go back to it: ./update.sh --rollback",
    ]);
    expect(box.env()).toBe(`${ENV}OMB_IMAGE=${NEW.refs[0]}\n`);
    expect(box.state().containers.omb).toMatchObject({ image: NEW.id, status: "running" });
    expect(tree(box.backup())).toEqual(before);
    expect(tree(box.data)["started-by.txt"]).toBe("0.1.150\n0.1.151\n");
    expect(box.journal()).toBe(false);
    const calls = box.calls();
    const order = [
      calls.findIndex((call) => call.startsWith("pull")), calls.indexOf("compose stop"), calls.findIndex((call) => call.includes("--entrypoint cp")),
      calls.findIndex((call) => call.startsWith("compose up")), calls.findLastIndex((call) => call.includes("/api/health")),
    ];
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(calls.find((call) => call.includes("--entrypoint cp"))).toBe(
      `run --rm --network none --user 0:0 --label com.mausbot.role=update-helper -v deploy_data:/from:ro -v deploy_data-before-update:/to --entrypoint cp ${OLD.id} -a /from/. /to/`,
    );
  });

  it("changes nothing when it is run again", () => {
    const box = install();
    expect(box.run().status).toBe(0);
    const calls = box.calls().length;
    const again = box.run();
    expect(again.status).toBe(0);
    expect(again.said).toEqual(["Downloading 0.1.151…", "This server already runs 0.1.151. Nothing to do."]);
    expect(box.calls().slice(calls).some((call) => /^(compose (stop|up)|run|volume)/.test(call))).toBe(false);
    expect(box.env()).toBe(`${ENV}OMB_IMAGE=${NEW.refs[0]}\n`);
  });

  it("puts back the old image, its settings and the data when the new version never answers", () => {
    const box = install({ behaviour: "silent" });
    const before = tree(box.data);
    const failed = box.run();
    expect(failed.status).toBe(1);
    expect(failed.said.slice(-3)).toEqual([
      "The update to 0.1.151 did not work: it did not answer within 2 seconds.",
      "Putting back the version and the data from before the update…",
      "Your server runs 0.1.150 again, with its data as it was before the update.",
    ]);
    expect(box.env()).toBe(ENV);
    expect(tree(box.data)).toEqual({ ...before, "started-by.txt": "0.1.150\n0.1.150\n" });
    expect(box.state().containers.omb).toMatchObject({ image: OLD.id, status: "running" });
    expect(box.state().containers.caddy.status).toBe("running");
    expect(box.journal()).toBe(false);
  });

  it("says why in the server's own last words when the new version stops as it starts", () => {
    const box = install({ behaviour: "crashes", lastWords: "This data was written by a newer MausBot." });
    const failed = box.run();
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("The update to 0.1.151 did not work: it kept stopping as it started (This data was written by a newer MausBot.).");
    expect(failed.said.at(-1)).toBe("Your server runs 0.1.150 again, with its data as it was before the update.");
    expect(tree(box.data)["started-by.txt"]).toBe("0.1.150\n0.1.150\n");
  });

  it.each([
    [{ engine: false }, "no engine can start a bot on it, and one could before"],
    [{ behaviour: "no-caddy" }, "Caddy, which serves it to the internet, did not start again"],
    [{ serves: "0.1.149" }, "it says it is version 0.1.149, not 0.1.151"],
  ])("rolls back a version that answers but lost what worked before: %j", (target, why) => {
    const box = install(target);
    const failed = box.run();
    expect(failed.status, failed.stdout).toBe(1);
    expect(failed.stdout).toContain(`The update to 0.1.151 did not work: ${why}.`);
    expect(box.state().containers.omb.image).toBe(OLD.id);
    expect(box.env()).toBe(ENV);
  });

  it("does not hold a missing engine against the new version when none worked before", () => {
    const box = install({ engine: false });
    box.setState({ images: [{ ...OLD, engine: false }, { ...NEW, engine: false }] });
    expect(box.run().status).toBe(0);
  });

  it("stops before touching the server when the image cannot be downloaded, the disk is short, or the Compose file is an old one", () => {
    for (const [extra, words] of [
      [{ failPull: true }, `Could not download ${NEW.refs[0]}`],
      [{ dataKb: 4_000_000, freeKb: 3_000_000 }, "There is not enough free disk for a copy of the data: it needs about 5320 MB and 2929 MB are free."],
      [{ composeReadsPin: false }, "does not take its image from OMB_IMAGE"],
    ] as const) {
      const box = install({}, extra);
      const refused = box.run();
      expect(refused.status, words).toBe(4);
      expect(refused.stdout).toContain(words);
      expect(refused.stdout).toContain("Nothing was changed.");
      expect(box.calls().some((call) => /^compose (stop|up)/.test(call))).toBe(false);
      expect(box.env()).toBe(ENV);
      expect(box.journal()).toBe(false);
    }
  });

  it("starts the server again as it was when the copy of the data fails", () => {
    const box = install({}, { failCopy: true });
    const before = tree(box.data);
    const refused = box.run();
    expect(refused.status).toBe(4);
    expect(refused.said.at(-1)).toMatch(/^Copying the data aside failed .* Nothing was changed, and the server was started again\.$/);
    expect(box.state().containers.omb).toMatchObject({ image: OLD.id, status: "running" });
    expect(existsSync(box.backup())).toBe(false);
    expect(tree(box.data)).toEqual({ ...before, "started-by.txt": "0.1.150\n0.1.150\n" });
  });

  it("refuses a second update while one runs, an image built on the machine, and a channel record that names no pinned image", () => {
    const busy = install();
    mkdirSync(join(busy.deploy, ".update", "lock"), { recursive: true });
    writeFileSync(join(busy.deploy, ".update", "lock", "pid"), String(process.pid));
    const second = busy.run();
    expect(second.status).toBe(3);
    expect(second.stdout).toContain(`An update is already running here (process ${process.pid}).`);
    expect(existsSync(join(busy.deploy, ".update", "lock"))).toBe(true);

    const built = install();
    built.setState({ images: [{ ...OLD, refs: [`${REPO}:latest`] }, NEW] });
    const refused = built.run();
    expect(refused.status).toBe(4);
    expect(refused.stdout).toContain("runs an image built on this machine");
    expect(built.run(["--replace-local-build"]).status).toBe(0);

    const unpinned = install();
    writeFileSync(join(unpinned.root, "stable.json"), JSON.stringify({ version: "0.1.151", image: `${REPO}:latest` }));
    expect(unpinned.run().stdout).toContain("The stable channel names no image this script accepts. Nothing was changed.");
  });

  it("takes over a lock whose update is gone", () => {
    const box = install();
    mkdirSync(join(box.deploy, ".update", "lock"), { recursive: true });
    writeFileSync(join(box.deploy, ".update", "lock", "pid"), "999999");
    const done = box.run();
    expect(done.status, done.stdout + done.stderr).toBe(0);
  });

  it("finishes an update that was killed while the new version started: the next run puts the old one back", () => {
    const box = install({ behaviour: "silent" }, { signalOn: { step: "compose up", signal: "SIGKILL" } });
    const before = tree(box.data);
    const killed = box.run();
    expect(killed.signal).toBe("SIGKILL");
    expect(box.journal()).toBe(true);
    expect(box.env()).toContain("OMB_IMAGE=");
    const next = box.run(["--check"]);
    expect(next.status).toBe(0);
    expect(box.journal()).toBe(true);
    const repaired = box.run();
    expect(repaired.said.slice(0, 3)).toEqual([
      "The update to 0.1.151 was interrupted.",
      "Putting back the version and the data from before the update…",
      "Your server runs 0.1.150 again, with its data as it was before the update.",
    ]);
    expect(repaired.status).toBe(1);
    expect(box.env()).toBe(ENV);
    expect(tree(box.data)).toEqual({ ...before, "started-by.txt": "0.1.150\n0.1.150\n" });
    expect(box.state().containers.omb.image).toBe(OLD.id);
  });

  it("keeps a new version that turned out healthy when the update was killed while waiting for it", () => {
    const box = install({}, { signalOn: { step: "compose exec -T omb sh", signal: "SIGKILL" } });
    expect(box.run().signal).toBe("SIGKILL");
    const next = box.run();
    expect(next.status).toBe(0);
    expect(next.said.slice(0, 2)).toEqual(["The last update was interrupted after the new version had started, and it is healthy.", "Updated from 0.1.150 to 0.1.151."]);
    expect(next.said.at(-1)).toBe("This server already runs 0.1.151. Nothing to do.");
    expect(box.state().containers.omb.image).toBe(NEW.id);
  });

  it("on Ctrl-C while copying, starts the server again with nothing changed; while waiting, puts the old version back", () => {
    const copying = install({}, { signalOn: { step: "run --rm --network none --user 0:0 --label com.mausbot.role=update-helper -v deploy_data:/from:ro -v deploy_data-before-update:/to", signal: "SIGINT" } });
    const stopped = copying.run();
    expect(stopped.status).toBe(130);
    expect(stopped.stdout).toContain("The update stopped while it copied the data aside. Nothing was changed, and the server was started again.");
    expect(copying.state().containers.omb).toMatchObject({ image: OLD.id, status: "running" });
    expect(copying.env()).toBe(ENV);
    expect(copying.journal()).toBe(false);

    const waiting = install({}, { signalOn: { step: "compose exec -T omb sh", signal: "SIGTERM" } });
    const before = tree(waiting.data);
    const back = waiting.run();
    expect(back.status).toBe(1);
    expect(back.said.at(-1)).toBe("Your server runs 0.1.150 again, with its data as it was before the update.");
    expect(waiting.env()).toBe(ENV);
    expect(tree(waiting.data)).toEqual({ ...before, "started-by.txt": "0.1.150\n0.1.150\n" });
  });

  it("goes back on request after a good update, once, and only after a typed yes", () => {
    const box = install();
    const before = tree(box.data);
    expect(box.run().status).toBe(0);
    writeFileSync(join(box.data, ".openmausbot", "bots.json"), "[]");
    const declined = box.run(["--rollback"], { input: "no\n" });
    expect(declined.status).toBe(4);
    expect(box.state().containers.omb.image).toBe(NEW.id);
    const back = box.run(["--rollback"], { input: "yes\n" });
    expect(back.status, back.stdout).toBe(0);
    expect(back.said.at(-1)).toBe("Your server runs 0.1.150 again, with its data as it was before the update.");
    expect(tree(box.data)).toEqual({ ...before, "started-by.txt": "0.1.150\n0.1.150\n" });
    expect(box.env()).toBe(ENV);
    expect(box.run(["--rollback", "--yes"]).stdout).toContain("There is no earlier update to go back from.");
  });

  it("puts the old version back when Docker cannot start the new one at all", () => {
    const box = install({}, { failUp: NEW.id });
    const failed = box.run();
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("Docker could not start 0.1.151");
    expect(failed.said.at(-1)).toBe("Your server runs 0.1.150 again, with its data as it was before the update.");
    expect(box.state().containers.omb).toMatchObject({ image: OLD.id, status: "running" });
    expect(box.env()).toBe(ENV);
  });

  it("says so, and leaves the copy alone, when the data cannot be put back", () => {
    const box = install({ behaviour: "silent" }, { failRestore: true });
    const before = tree(box.data);
    const failed = box.run();
    expect(failed.status).toBe(2);
    expect(failed.said.at(-1)).toContain("The data could not be put back from the Docker volume deploy_data-before-update");
    expect(tree(box.backup())).toEqual(before);
  });

  it("updates to a named version, and --check changes nothing", () => {
    const box = install();
    const check = box.run(["--check"]);
    expect(check.said).toEqual(["This server runs 0.1.150.", "./update.sh would update it to 0.1.151."]);
    expect(box.calls().some((call) => /^(pull|compose (stop|up)|run|volume)/.test(call))).toBe(false);
    expect(existsSync(join(box.deploy, ".update"))).toBe(false);
    const done = box.run(["--version", "v0.1.151"]);
    expect(done.status, done.stdout).toBe(0);
    expect(box.calls()).toContain(`pull -q ${REPO}:v0.1.151`);
    expect(box.env()).toBe(`${ENV}OMB_IMAGE=${NEW.refs[0]}\n`);
  });
});
