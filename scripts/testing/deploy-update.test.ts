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
/** .env after a rollback: as it was, with the version that ran before pinned by its digest, so a tag that moved since
 * (the installer's `stable`) cannot bring the undone version back on a later run of the installer. */
const ROLLED_BACK = `${ENV}OMB_IMAGE=${OLD.refs[1]}\n`;

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

/** A stable.json as promote-stable.yml writes it: the newest entry first, then every version stable before it. */
function stableRecord(version: string, image: string, earlier: string[] = []) {
  const history = [version, ...earlier].map((entry, at) => ({ version: entry, promotedAt: `2026-11-${String(10 - at).padStart(2, "0")}T00:00:00.000Z` }));
  return JSON.stringify({ channel: "stable", version, image, cloudHomeImage: `${REPO}-cloud-home@${id("9")}`, platforms: ["linux/amd64", "linux/arm64"], promotedAt: history[0]!.promotedAt, history }, null, 2);
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
  writeFileSync(join(root, "stable.json"), stableRecord(next.version, next.refs[0]!));
  const state = () => JSON.parse(readFileSync(join(fake, "state.json"), "utf8"));
  const run = (args: string[] = [], options: { input?: string; env?: Record<string, string>; umask?: string } = {}) => {
    const script = [join(deploy, "update.sh"), ...args];
    const command = options.umask ? ["-c", `umask ${options.umask}; exec bash "$0" "$@"`, ...script] : script;
    const result = spawnSync("bash", command, {
      encoding: "utf8", input: options.input ?? "", timeout: 60_000,
      env: {
        // sbin: sha256sum is /sbin/sha256sum on macOS.
        PATH: `${join(root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, FAKE_DOCKER_DIR: fake,
        OMB_STABLE_URL: `file://${join(root, "stable.json")}`, OMB_NEWEST_URL: `file://${join(root, "newest.json")}`,
        OMB_UPDATE_POLL_S: "0", OMB_UPDATE_WAIT_S: "120", OMB_UPDATE_ENGINE_WAIT_S: "1", ...wait, ...options.env,
      },
    });
    return { ...result, said: result.stdout.trim().split("\n") };
  };
  const calls = () => (existsSync(join(fake, "calls.log")) ? readFileSync(join(fake, "calls.log"), "utf8").trim().split("\n") : []);
  /** The copies of the data an update made, oldest first: one Docker volume each. */
  const copies = () => readdirSync(join(fake, "volumes")).filter((name) => name.startsWith("deploy_data-before-update-")).sort();
  return {
    root, deploy, fake, data, state, run, calls, copies,
    setState: (patch: Record<string, unknown>) => writeFileSync(join(fake, "state.json"), JSON.stringify({ ...state(), ...patch })),
    env: () => readFileSync(join(deploy, ".env"), "utf8"),
    backup: () => {
      const [only, ...more] = copies();
      if (!only || more.length) throw new Error(`expected one copy of the data, found: ${copies().join(", ")}`);
      return join(fake, "volumes", only);
    },
    journal: () => existsSync(join(deploy, ".update", "journal")),
    last: () => existsSync(join(deploy, ".update", "last")),
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
      `The data from before the update is kept in the Docker volume ${box.copies()[0]} until the next update.`,
      "To go back to it: ./update.sh --rollback",
    ]);
    expect(box.copies()).toEqual([expect.stringMatching(/^deploy_data-before-update-\d{8}T\d{6}Z$/)]);
    expect(box.env()).toBe(`${ENV}OMB_IMAGE=${NEW.refs[0]}\n`);
    expect(box.state().containers.omb).toMatchObject({ image: NEW.id, status: "running" });
    expect(tree(box.backup())).toEqual(before);
    expect(tree(box.data)["started-by.txt"]).toBe("0.1.150\n0.1.151\n");
    expect(box.journal()).toBe(false);
    const calls = box.calls();
    const order = [
      calls.findIndex((call) => call.startsWith("pull")), calls.indexOf("compose stop"), calls.findIndex((call) => call.includes("--entrypoint cp")),
      calls.findIndex((call) => call.includes("same /from /to")), calls.findIndex((call) => call.startsWith("compose up")),
      calls.findLastIndex((call) => call.includes("/api/health")),
    ];
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(calls.find((call) => call.includes("--entrypoint cp"))).toBe(
      `run --rm --network none --user 0:0 --label com.mausbot.role=update-helper -v deploy_data:/from:ro -v ${box.copies()[0]}:/to --entrypoint cp ${OLD.id} -a /from/. /to/`,
    );
    // The server was stopped, and seen to be stopped, before the copy.
    expect(calls.slice(calls.indexOf("compose stop"), calls.findIndex((call) => call.includes("--entrypoint cp"))).some((call) => call.includes("{{.State.Running}}"))).toBe(true);
  });

  it("changes nothing when it is run again", () => {
    const box = install();
    expect(box.run().status).toBe(0);
    const calls = box.calls().length;
    const again = box.run();
    expect(again.status).toBe(0);
    expect(again.said).toEqual(["Downloading 0.1.151…", "This server already runs 0.1.151. Nothing to do."]);
    expect(box.calls().slice(calls).some((call) => /^(compose (stop|up)|run|volume (create|rm))/.test(call))).toBe(false);
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
    expect(box.env()).toBe(ROLLED_BACK);
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
    expect(box.env()).toBe(ROLLED_BACK);
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
    expect(refused.said.at(-1)).toMatch(/^Copying the data aside failed, .* Nothing was changed, and the server was started again\.$/);
    expect(box.state().containers.omb).toMatchObject({ image: OLD.id, status: "running" });
    expect(box.copies()).toEqual([]);
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

  // As the real-server check's step 6 runs it: killed while it waits for a version that never answers, then a `yes`
  // piped in. Its health checks run `docker compose exec`, which forwards standard input to the container: the answer
  // must still reach the question, and the old image, the data and .env (on a version tag) come back exactly.
  it("after an update killed while it waits, a piped yes puts the old image, the data and .env back", () => {
    const box = install({ behaviour: "silent" }, {
      images: [{ ...OLD, refs: [...OLD.refs, `${REPO}:v0.1.150`] }, { ...NEW, behaviour: "silent" }],
      signalOn: { match: "/api/health\"", signal: "SIGKILL" },
    });
    writeFileSync(join(box.deploy, ".env"), `${ENV}OMB_IMAGE=${REPO}:v0.1.150\n`, { mode: 0o600 });
    const envBefore = box.env();
    const before = tree(box.data);
    expect(box.run().signal).toBe("SIGKILL");
    expect(box.journal()).toBe(true);
    expect(box.state().containers.omb.image).toBe(NEW.id);
    const unanswered = box.run([], { input: "" });
    expect(unanswered.status, unanswered.stdout).toBe(4);
    expect(box.state().containers.omb.image).toBe(NEW.id);
    const yes = box.run([], { input: "yes\n" });
    expect(yes.said.at(-1), yes.stdout).toBe("Your server runs 0.1.150 again, with its data as it was before the update.");
    expect(yes.status).toBe(1);
    expect(box.state().containers.omb.image).toBe(OLD.id);
    expect(box.env()).toBe(envBefore);
    expect(tree(box.data)).toEqual({ ...before, "started-by.txt": "0.1.150\n0.1.150\n" });
    expect(box.journal()).toBe(false);
  });

  it("asks before it undoes an update an earlier run left unhealthy, says what that loses, and changes nothing without a yes", () => {
    const box = install({ behaviour: "silent" }, { signalOn: { step: "compose up", signal: "SIGKILL" } });
    const before = tree(box.data);
    const killed = box.run();
    expect(killed.signal).toBe("SIGKILL");
    expect(box.journal()).toBe(true);
    expect(box.env()).toContain("OMB_IMAGE=");
    const next = box.run(["--check"]);
    expect(next.status).toBe(0);
    expect(next.stdout).toContain("An earlier update did not finish.");
    expect(box.journal()).toBe(true);
    // The new version has been running on the data since: nothing may take that away unasked.
    const since = tree(box.data);
    for (const unanswered of [box.run(), box.run([], { input: "no\n" }), box.run(["--rollback"])]) {
      expect(unanswered.status, unanswered.stdout).toBe(4);
      expect(unanswered.stdout).toMatch(/An earlier update to 0\.1\.151, started \S+Z, did not finish/);
      expect(unanswered.stdout).toContain("Everything made on this server since then (chats, files, settings) is lost.");
      expect(unanswered.said.at(-1)).toContain("Nothing was changed.");
      expect(tree(box.data)).toEqual(since);
      expect(box.journal()).toBe(true);
    }
    const repaired = box.run([], { input: "yes\n" });
    expect(repaired.said.slice(-3)).toEqual([
      "Going back, as asked.",
      "Putting back the version and the data from before the update…",
      "Your server runs 0.1.150 again, with its data as it was before the update.",
    ]);
    expect(repaired.status).toBe(1);
    expect(box.env()).toBe(ROLLED_BACK);
    expect(tree(box.data)).toEqual({ ...before, "started-by.txt": "0.1.150\n0.1.150\n" });
    expect(box.state().containers.omb.image).toBe(OLD.id);
  });

  it("keeps a new version that turned out healthy when the update was killed while waiting for it", () => {
    const box = install({}, { signalOn: { match: "/api/health\"", signal: "SIGKILL" } });
    expect(box.run().signal).toBe("SIGKILL");
    const next = box.run();
    expect(next.status).toBe(0);
    expect(next.said.slice(0, 2)).toEqual(["The last update was interrupted after the new version had started, and it is healthy.", "Updated from 0.1.150 to 0.1.151."]);
    expect(next.said.at(-1)).toBe("This server already runs 0.1.151. Nothing to do.");
    expect(box.state().containers.omb.image).toBe(NEW.id);
  });

  it("on Ctrl-C while copying, starts the server again with nothing changed; while waiting, puts the old version back", () => {
    const copying = install({}, { signalOn: { match: "--entrypoint cp ", signal: "SIGINT" } });
    const stopped = copying.run();
    expect(stopped.status).toBe(130);
    expect(stopped.stdout).toContain("The update stopped while it copied the data aside. Nothing was changed, and the server was started again.");
    expect(copying.state().containers.omb).toMatchObject({ image: OLD.id, status: "running" });
    expect(copying.env()).toBe(ENV);
    expect(copying.journal()).toBe(false);

    const waiting = install({}, { signalOn: { match: "/api/health\"", signal: "SIGTERM" } });
    const before = tree(waiting.data);
    const back = waiting.run();
    expect(back.status).toBe(1);
    expect(back.said.at(-1)).toBe("Your server runs 0.1.150 again, with its data as it was before the update.");
    expect(waiting.env()).toBe(ROLLED_BACK);
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
    expect(box.env()).toBe(ROLLED_BACK);
    expect(box.run(["--rollback", "--yes"]).stdout).toContain("There is no earlier update to go back from.");
  });

  // A released version's own tag, or a digest, never moves: .env comes back byte for byte. Only a moving tag (`stable`,
  // `latest`, or none) is replaced by the digest of the version that ran.
  it("puts .env back exactly when it named a tag that does not move", () => {
    for (const named of [`${REPO}:v0.1.150`, OLD.refs[1]!]) {
      const box = install({}, { images: [{ ...OLD, refs: [...OLD.refs, `${REPO}:v0.1.150`] }, NEW] });
      writeFileSync(join(box.deploy, ".env"), `${ENV}OMB_IMAGE=${named}\n`, { mode: 0o600 });
      const before = box.env();
      expect(box.run().status).toBe(0);
      expect(box.env()).not.toBe(before);
      const back = box.run(["--rollback", "--yes"]);
      expect(back.status, back.stdout).toBe(0);
      expect(box.env(), named).toBe(before);
    }
    const moving = install();
    writeFileSync(join(moving.deploy, ".env"), `${ENV}OMB_IMAGE=${REPO}:stable\n`);
    expect(moving.run().status).toBe(0);
    expect(moving.run(["--rollback", "--yes"]).status).toBe(0);
    expect(moving.env()).toBe(`${ENV}OMB_IMAGE=${OLD.refs[1]}\n`);
  });

  // A hardened server answers `openmausbot doctor` without a session with a refusal, so before the server's own count
  // the check that a bot can still start never ran there.
  it("checks a hardened version's engines with the server's own count, where doctor is refused", () => {
    const hardened = { counts: true, doctor: false };
    const lost = install({ ...hardened, engine: false });
    lost.setState({ images: [{ ...OLD, ...hardened }, { ...NEW, ...hardened, engine: false }] });
    const failed = lost.run();
    expect(failed.status, failed.stdout).toBe(1);
    expect(failed.stdout).toContain("The update to 0.1.151 did not work: no engine can start a bot on it, and one could before.");
    const kept = install(hardened);
    kept.setState({ images: [{ ...OLD, ...hardened }, { ...NEW, ...hardened }] });
    expect(kept.run().status).toBe(0);
    expect(kept.state().containers.omb.image).toBe(NEW.id);
  });

  it("moves an install the installer made with Caddy in the server's network to the current files, and back on rollback", () => {
    const box = install();
    const oldCompose = `# Written by MausBot's installer (deploy/install.sh), and written again each time it runs.
name: openmausbot
services:
  omb:
    image: \${OMB_IMAGE:?run the installer again}
  caddy:
    image: caddy:2
    network_mode: "service:omb"
`;
    const oldCaddyfile = "{$DOMAIN} {\n\treverse_proxy 127.0.0.1:8799\n}\n";
    writeFileSync(join(box.deploy, "compose.yaml"), oldCompose);
    writeFileSync(join(box.deploy, "Caddyfile"), oldCaddyfile);
    expect(box.run(["--check"]).stdout).toContain("It would also move Caddy to its own container");
    // Under umask 000, as a root shell may have it: the files root starts from are still the owner's alone to change.
    const done = box.run([], { umask: "000" });
    expect(done.status, done.stdout).toBe(0);
    expect(done.said).toContain("Caddy moves to its own container, so HTTPS stays up whenever the server restarts on its own.");
    for (const file of ["compose.yaml", "Caddyfile"]) expect((statSync(join(box.deploy, file)).mode & 0o777).toString(8), file).toBe("644");
    expect((statSync(join(box.deploy, ".update")).mode & 0o777).toString(8)).toBe("700");
    const compose = readFileSync(join(box.deploy, "compose.yaml"), "utf8");
    expect(compose).not.toContain("network_mode");
    expect(compose).toContain("- edge:/run/openmausbot");
    expect(readFileSync(join(box.deploy, "Caddyfile"), "utf8")).toContain("reverse_proxy unix//run/openmausbot/http.sock");
    expect(box.run(["--rollback", "--yes"]).status).toBe(0);
    expect(readFileSync(join(box.deploy, "compose.yaml"), "utf8")).toBe(oldCompose);
    expect(readFileSync(join(box.deploy, "Caddyfile"), "utf8")).toBe(oldCaddyfile);
    expect(box.env()).toBe(ROLLED_BACK);
  });

  it("says how to move this repository's docker-compose.yml when it still has Caddy in the server's network", () => {
    const box = install();
    writeFileSync(join(box.deploy, "docker-compose.yml"), 'services:\n  caddy:\n    network_mode: "service:omb"\n');
    expect(box.run(["--check"]).stdout).toContain("git pull brings the current one");
    const done = box.run();
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("Note: this docker-compose.yml runs Caddy in the server's network");
    expect(readFileSync(join(box.deploy, "docker-compose.yml"), "utf8")).toContain("network_mode");
  });

  it("puts the old version back when Docker cannot start the new one at all", () => {
    const box = install({}, { failUp: NEW.id });
    const failed = box.run();
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("Docker could not start 0.1.151");
    expect(failed.said.at(-1)).toBe("Your server runs 0.1.150 again, with its data as it was before the update.");
    expect(box.state().containers.omb).toMatchObject({ image: OLD.id, status: "running" });
    expect(box.env()).toBe(ROLLED_BACK);
  });

  it("when the data cannot be put back: leaves the data and the copy as they are, keeps the journal, and tries again only when asked", () => {
    const box = install({ behaviour: "silent" }, { failRestore: true });
    const before = tree(box.data);
    const failed = box.run();
    expect(failed.status).toBe(2);
    expect(failed.stdout).toContain(`The data could not be put back from the Docker volume ${box.copies()[0]}`);
    expect(failed.said.at(-1)).toContain("./update.sh --rollback tries again");
    // Nothing half-restored, no old version started on the data the new one left, and nothing forgotten.
    const left = tree(box.data);
    expect(left).toEqual({ ...before, "started-by.txt": "0.1.150\n0.1.151\n" });
    expect(tree(box.backup())).toEqual(before);
    expect(box.state().containers.omb.status).toBe("exited");
    expect(box.env()).toBe(`${ENV}OMB_IMAGE=${NEW.refs[0]}\n`);
    expect(box.journal()).toBe(true);

    // The next update neither replaces the copy nor touches the data until someone says yes.
    box.setState({ failRestore: false });
    const next = box.run();
    expect(next.status).toBe(4);
    expect(next.stdout).toContain("was being undone, and putting its data back did not finish.");
    expect(tree(box.data)).toEqual(left);
    expect(tree(box.backup())).toEqual(before);
    expect(box.calls().filter((call) => call.includes("--entrypoint cp"))).toHaveLength(1);

    const back = box.run(["--rollback", "--yes"]);
    expect(back.status, back.stdout).toBe(0);
    expect(back.said.at(-1)).toBe("Your server runs 0.1.150 again, with its data as it was before the update.");
    expect(tree(box.data)).toEqual({ ...before, "started-by.txt": "0.1.150\n0.1.150\n" });
    expect(box.env()).toBe(ROLLED_BACK);
    expect(box.journal()).toBe(false);
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

  it("reads the version from the record's top level, whatever its history holds", () => {
    const box = install();
    writeFileSync(join(box.root, "stable.json"), stableRecord("0.1.151", NEW.refs[0]!, ["0.1.150", "0.1.149", "0.1.148"]));
    const done = box.run();
    expect(done.status, done.stdout).toBe(0);
    expect(done.said).toContain("Updated from 0.1.150 to 0.1.151.");
    // Keys in any order, on one line, with the history before the version.
    const again = install();
    writeFileSync(join(again.root, "stable.json"), JSON.stringify({ history: [{ version: "0.1.151" }, { version: "0.1.140" }], image: NEW.refs[0], version: "0.1.151" }));
    expect(again.run().said).toContain("Updated from 0.1.150 to 0.1.151.");
    // A record whose top level names no version is refused, not read from its history.
    const bare = install();
    writeFileSync(join(bare.root, "stable.json"), JSON.stringify({ image: NEW.refs[0], history: [{ version: "0.1.151" }] }));
    const refused = bare.run();
    expect(refused.status).toBe(4);
    expect(refused.stdout).toContain("The stable channel names no image this script accepts.");
  });

  it("carries on when the terminal closes in the middle of an update", () => {
    const box = install({}, { signalOn: { match: "/api/health\"", signal: "SIGHUP" } });
    const done = box.run();
    expect(done.signal).toBe(null);
    expect(done.status, done.stdout).toBe(0);
    expect(done.said).toContain("Updated from 0.1.150 to 0.1.151.");
    expect(box.state().containers.omb.image).toBe(NEW.id);
    expect(box.journal()).toBe(false);
  });

  it("on Ctrl-C while it looks at an earlier run's unfinished update, changes nothing", () => {
    const box = install({ behaviour: "silent" }, { signalOn: { step: "compose up", signal: "SIGKILL" } });
    expect(box.run().signal).toBe("SIGKILL");
    const since = tree(box.data);
    box.setState({ signalOn: { match: "State.Status", signal: "SIGINT" } });
    const stopped = box.run([], { input: "yes\n" });
    expect(stopped.status).toBe(130);
    expect(stopped.said.slice(-2)).toEqual(["Interrupted.", "Nothing was changed."]);
    expect(box.journal()).toBe(true);
    expect(tree(box.data)).toEqual(since);
    expect(box.calls().some((call) => call.includes(".omb-restore"))).toBe(false);
  });

  it("keeps the server as it is when an earlier update is left unfinished and the owner says keep", () => {
    const box = install({ behaviour: "silent" }, { signalOn: { match: "/api/health\"", signal: "SIGKILL" } });
    expect(box.run().signal).toBe("SIGKILL");
    const kept = box.run([], { input: "keep\n" });
    expect(kept.status, kept.stdout).toBe(0);
    expect(kept.stdout).toContain("Left as it is.");
    expect(kept.said.at(-1)).toBe("This server already runs 0.1.151. Nothing to do.");
    expect(box.state().containers.omb.image).toBe(NEW.id);
    expect(box.journal()).toBe(false);
    expect(box.last()).toBe(true);
  });

  it("never goes to an older version unless told to, judged by the version the server says it is", () => {
    // 0.1.152 runs, and stable is still 0.1.151.
    const newer = install();
    newer.setState({ images: [{ ...OLD, version: "0.1.152" }, NEW] });
    const refused = newer.run();
    expect(refused.status).toBe(5);
    expect(refused.stdout).toContain("This server runs 0.1.152, which is newer than 0.1.151.");
    expect(refused.said.at(-1)).toContain("Nothing was changed. To go ahead anyway, with the data copied first: ./update.sh --allow-older");
    expect(newer.calls().some((call) => /^(compose (stop|up)|run)/.test(call))).toBe(false);
    expect(newer.env()).toBe(ENV);
    expect(newer.journal()).toBe(false);
    expect(newer.copies()).toEqual([]);
    expect(newer.run(["--check"]).stdout).toContain("./update.sh would change nothing without --allow-older.");
    const told = newer.run(["--allow-older"]);
    expect(told.status, told.stdout).toBe(0);
    expect(told.said).toContain("Updated from 0.1.152 to 0.1.151.");

    // A build of main (`latest`) is labelled with the branch; it says the version of the release it was built after.
    const main = install();
    main.setState({ images: [{ ...OLD, version: undefined, label: "main", serves: "0.1.151" }, NEW] });
    const same = main.run();
    expect(same.status).toBe(5);
    expect(same.stdout).toContain("This server runs a build of main that says 0.1.151, and may hold changes made after 0.1.151 was released.");
    const behind = install();
    behind.setState({ images: [{ ...OLD, version: undefined, label: "main", serves: "0.1.150" }, NEW] });
    const moved = behind.run();
    expect(moved.status, moved.stdout).toBe(0);
    expect(behind.state().containers.omb.image).toBe(NEW.id);
  });

  it("does not copy the data until the server has stopped, and drops a copy that does not match", () => {
    for (const [extra, words] of [
      [{ failStop: true }, "The server could not be stopped"],
      [{ corruptCopy: true }, "Copying the data aside failed, or the copy did not match the data"],
    ] as const) {
      const box = install({}, extra);
      const before = tree(box.data);
      const refused = box.run();
      expect(refused.status, words).toBe(4);
      expect(refused.said.at(-1)).toContain(words);
      expect(refused.said.at(-1)).toContain("Nothing was changed, and the server was started again.");
      expect(box.state().containers.omb.image).toBe(OLD.id);
      expect(box.env()).toBe(ENV);
      expect(box.copies()).toEqual([]);
      expect(box.journal()).toBe(false);
      if ("failStop" in extra) expect(box.calls().some((call) => call.includes("--entrypoint cp"))).toBe(false);
      else expect(tree(box.data)).toEqual({ ...before, "started-by.txt": "0.1.150\n0.1.150\n" });
    }
  });

  it("keeps the copy from the update before until the next copy has been checked", () => {
    const NEWER = { id: id("c"), refs: [`${REPO}@${id("3")}`, `${REPO}:v0.1.152`], version: "0.1.152", local: false, engine: true };
    const box = install();
    expect(box.run().status).toBe(0);
    const [first] = box.copies();
    box.setState({ images: [...box.state().images, NEWER] });
    writeFileSync(join(box.root, "stable.json"), stableRecord("0.1.152", NEWER.refs[0]!, ["0.1.151"]));
    box.setState({ corruptCopy: true });
    expect(box.run().status).toBe(4);
    expect(box.copies()).toEqual([first]);
    expect(box.last()).toBe(true);
    const done = box.run();
    expect(done.status, done.stdout).toBe(0);
    expect(done.said).toContain("Updated from 0.1.151 to 0.1.152.");
    expect(box.copies()).toHaveLength(1);
    expect(box.copies()[0]).not.toBe(first);
  });

  it("takes the newest release until a first version is made stable, and stops on a channel it cannot reach", () => {
    const box = install();
    rmSync(join(box.root, "stable.json"));
    writeFileSync(join(box.root, "newest.json"), JSON.stringify({ tag_name: "v0.1.151", html_url: "https://example.test/release", assets: [{ name: "x", version: "9.9.9" }] }));
    const done = box.run();
    expect(done.status, done.stdout).toBe(0);
    expect(done.said[0]).toBe("No version has been made stable yet, so this takes the newest release, 0.1.151.");
    expect(box.calls()).toContain(`pull -q ${REPO}:v0.1.151`);
    expect(box.env()).toBe(`${ENV}OMB_IMAGE=${NEW.refs[0]}\n`);

    const unreachable = install();
    const refused = unreachable.run([], { env: { OMB_STABLE_URL: "http://127.0.0.1:9/stable.json" } });
    expect(refused.status).toBe(4);
    expect(refused.stdout).toContain("Could not read the stable channel");
    expect(unreachable.calls().some((call) => call.startsWith("pull"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("says plainly that the install folder cannot be written, and changes nothing", () => {
    const box = install();
    chmodSync(box.deploy, 0o555);
    try {
      const refused = box.run();
      expect(refused.status).toBe(4);
      expect(refused.stdout).toContain("cannot be written by this user");
    } finally {
      chmodSync(box.deploy, 0o755);
    }
  });
});
