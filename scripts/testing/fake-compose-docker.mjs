#!/usr/bin/env node
// A stand-in for the `docker` CLI that deploy/update.sh drives: one Compose project (omb and caddy) whose state is a
// JSON file, and whose volumes are real folders, so a copy or a restore moves real files. FAKE_DOCKER_DIR holds it all.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_DOCKER_DIR;
const stateFile = join(dir, "state.json");
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 1));
const args = process.argv.slice(2);
const line = args.join(" ");
appendFileSync(join(dir, "calls.log"), `${line}\n`);

const out = (text) => process.stdout.write(`${text}\n`);
const fail = (text, code = 1) => {
  process.stderr.write(`${text}\n`);
  save();
  process.exit(code);
};
const volume = (name) => join(dir, "volumes", name.replaceAll("/", "_"));
/** An image by any name it has: its id, a tag, or a digest reference. */
const image = (ref) => state.images.find((candidate) => candidate.local && (candidate.id === ref || candidate.refs.includes(ref)));
const envFile = () => (existsSync(join(process.cwd(), ".env")) ? readFileSync(join(process.cwd(), ".env"), "utf8") : "");
const pinned = () => process.env.OMB_IMAGE ?? /^OMB_IMAGE=(.*)$/m.exec(envFile())?.[1] ?? null;
const composeImage = () => (state.composeReadsPin && pinned()) || state.defaultImage;

/** `{step: "compose up", signal: "SIGKILL"}`: the update script is signalled as this call starts, once. */
const trip = state.signalOn;
if (trip && line.startsWith(trip.step)) {
  delete state.signalOn;
  save();
  process.kill(Number(readFileSync(join(process.cwd(), ".update", "lock", "pid"), "utf8")), trip.signal);
  if (trip.signal === "SIGKILL") process.exit(137);
}

function composeUp() {
  const wanted = image(composeImage());
  if (!wanted) fail(`pull access denied for ${composeImage()}`);
  if (state.failUp === wanted.id) fail("Error response from daemon: driver failed programming external connectivity");
  const crashes = wanted.behaviour === "crashes";
  state.containers.omb = { id: `omb-${++state.serial}`, image: wanted.id, status: crashes ? "restarting" : "running", restarts: crashes ? 5 : 0 };
  state.containers.caddy = { id: `caddy-${state.serial}`, status: wanted.behaviour === "no-caddy" ? "exited" : "running" };
  // A server that starts writes to its data, as a new version's migrations do.
  if (!crashes) appendFileSync(join(volume(state.dataVolume), "started-by.txt"), `${wanted.version}\n`);
}

function compose(rest) {
  const [verb, ...more] = rest;
  const omb = state.containers.omb;
  if (verb === "version") return out("Docker Compose version v2.40.0");
  if (verb === "config") return out(`services:\n  omb:\n    image: ${composeImage()}`);
  if (verb === "ps" && more.includes("-aq")) return omb ? out(omb.id) : undefined;
  if (verb === "ps") return Object.entries(state.containers).filter(([, container]) => container?.status === "running").forEach(([name]) => out(name));
  if (verb === "stop") {
    for (const container of Object.values(state.containers)) if (container) Object.assign(container, { status: "exited" });
    return;
  }
  if (verb === "up") return composeUp();
  if (verb === "logs") return out(image(omb?.image)?.lastWords ?? "");
  if (verb === "exec") {
    const serving = image(omb?.image);
    if (omb?.status !== "running" || !serving) fail("service omb is not running");
    if (more.includes("openmausbot")) return serving.engine ? out("ready") : fail("no engine is available", 5);
    if (serving.behaviour === "silent") fail("", 7);
    if (line.includes("/api/health")) return out('{"app":"openmausbot"}');
    if (line.includes("/environment")) return out(JSON.stringify({ environmentId: "e", version: serving.serves ?? serving.version }));
  }
  fail(`fake docker: unknown compose command: ${line}`, 64);
}

function inspect(format, target) {
  const omb = state.containers.omb;
  if (!omb || omb.id !== target) fail(`No such object: ${target}`);
  if (format === "{{.Image}}") return out(omb.image);
  if (format === "{{.State.Running}}") return out(String(omb.status === "running"));
  if (format === "{{.State.Status}} {{.RestartCount}} {{.Image}}") return out(`${omb.status} ${omb.restarts} ${omb.image}`);
  if (format.includes(".Mounts")) return out(state.dataVolume);
  if (format.includes("com.docker.compose.project")) return out("deploy");
  fail(`fake docker: unknown inspect format: ${format}`, 64);
}

function imageInspect(format, ref) {
  const found = image(ref);
  if (!found) fail(`No such image: ${ref}`);
  if (format === "{{.Id}}") return out(found.id);
  if (format.includes(".RepoDigests")) return found.refs.filter((name) => name.includes("@sha256:")).forEach((name) => out(name));
  if (format.includes("image.version")) return out(found.version ? `v${found.version}` : "");
  fail(`fake docker: unknown image format: ${format}`, 64);
}

/** `run … -v a:/from:ro -v b:/to --entrypoint <cmd> <image> <args>`: the command really runs, on the volumes' folders. */
function run(rest) {
  const mounts = {};
  rest.forEach((arg, at) => {
    if (arg !== "-v") return;
    const [source, target] = rest[at + 1].split(":");
    mounts[target] = volume(source);
  });
  const entry = rest[rest.indexOf("--entrypoint") + 1];
  const tail = rest.slice(rest.indexOf("--entrypoint") + 3);
  if (state.failCopy && entry === "cp") fail("cp: error writing '/to/messages.db': No space left on device");
  if (state.failRestore && entry === "sh" && tail[1].includes("find /to")) fail("cp: cannot create regular file");
  if (Object.values(mounts).some((folder) => !folder.startsWith(join(dir, "volumes")))) fail("fake docker: a mount outside the fixture", 64);
  const inFolders = (text) => text.replace(/\/(from|to)(?=[/\s.]|$)/g, (_, name) => mounts[`/${name}`] ?? join(dir, "volumes", "unmounted"));
  if (entry === "sh" && tail[1].startsWith("du -sk")) return out(`${state.dataKb ?? 1024}\n${state.freeKb ?? 50_000_000}`);
  const done = spawnSync(entry, tail.map(inFolders), { stdio: "inherit" });
  if (done.status !== 0) fail(`helper exited ${done.status}`, done.status ?? 1);
}

function main() {
  const [verb, ...rest] = args;
  if (verb === "compose") return compose(rest);
  if (verb === "inspect") return inspect(rest[1], rest[2]);
  if (verb === "image" && rest[0] === "inspect") return imageInspect(rest[2], rest[3]);
  if (verb === "pull") {
    const ref = rest.at(-1);
    const found = state.images.find((candidate) => candidate.refs.includes(ref));
    if (!found || state.failPull) fail(`Error response from daemon: manifest for ${ref} not found`);
    found.local = true;
    return;
  }
  if (verb === "tag") return void image(rest[0])?.refs.push(rest[1]);
  if (verb === "run") return run(rest);
  if (verb === "volume") {
    const name = rest.at(-1);
    if (rest[0] === "rm") return rmSync(volume(name), { recursive: true, force: true });
    if (rest[0] === "create") return mkdirSync(volume(name), { recursive: true });
    if (rest[0] === "inspect") return existsSync(volume(name)) ? out(name) : fail(`no such volume: ${name}`);
  }
  fail(`fake docker: unknown command: ${line}`, 64);
}

main();
save();
