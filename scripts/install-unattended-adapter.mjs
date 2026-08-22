#!/usr/bin/env node

/** Install an exact, immutable, dormant OpenMausBot submission/status build. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), "..");
const LABEL = "com.gus.aos-unattended-openmausbot";

function fail(message) {
  throw new Error(message);
}

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0) fail(`${basename(command)} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  return result.stdout.trim();
}

function requireAbsoluteSafePath(value, label) {
  if (!isAbsolute(value) || resolve(value) !== value || value === "/" || value === homedir()) {
    fail(`${label} must be a normalized absolute child path`);
  }
}

function validatePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail(`${label} is invalid`);
  return port;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function treeHash(root, excluded = new Set()) {
  const hash = createHash("sha256");
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const artifactPath = relative(root, path);
      if (excluded.has(artifactPath)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail(`runtime artifact contains symlink: ${artifactPath}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        hash.update(artifactPath);
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function requireOwnedTarget(path, label, kind) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail(`${label} must not be a symlink`);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    fail(`${label} must be a ${kind}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) fail(`${label} must be owned by the current user`);
  return stat;
}

function removeWriteBits(root) {
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    }
    chmodSync(path, stat.mode & ~0o222);
  };
  visit(root);
}

function launchAgent({ node, server, staticDir, dataRoot, appPort, webhookPort, planePort }) {
  const entries = {
    HOME: dataRoot,
    USERPROFILE: dataRoot,
    OMB_PORT: String(appPort),
    OMB_WEBHOOK_PORT: String(webhookPort),
    OMB_STATIC_DIR: staticDir,
    OMB_UNATTENDED_ADAPTER_ONLY: "1",
    OMB_UNATTENDED_WORK_ENABLED: "0",
    OMB_UNATTENDED_WORK_URL: `http://127.0.0.1:${planePort}`,
  };
  const environment = Object.entries(entries)
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array><string>${xml(node)}</string><string>${xml(server)}</string></array>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>RunAtLoad</key><false/>
    <key>KeepAlive</key><false/>
    <key>ProcessType</key><string>Background</string>
  </dict>
</plist>
`;
}

function atomicWrite(path, body, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, body, { mode, flag: "wx" });
  renameSync(temporary, path);
}

function serviceIsLoaded() {
  if (process.platform !== "darwin") return false;
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  return spawnSync("launchctl", ["print", `gui/${uid}/${LABEL}`], {
    stdio: "ignore",
  }).status === 0;
}

export function ensureLaunchAgent(path, body) {
  if (existsSync(path)) {
    requireOwnedTarget(path, "LaunchAgent artifact", "regular file");
    chmodSync(path, 0o600);
    if (readFileSync(path, "utf8") !== body) fail("existing LaunchAgent artifact does not match the exact generation");
    return;
  }
  atomicWrite(path, body, 0o600);
}

export function main() {
  const expectedSha = argument("--expected-sha");
  if (!expectedSha || !/^[0-9a-f]{40}$/.test(expectedSha)) fail("--expected-sha must be a full lowercase Git SHA");
  const runtimeRoot = argument("--runtime-root", join(homedir(), ".local", "share", "aos-unattended-work", "openmausbot"));
  const dataRoot = argument("--data-root", join(homedir(), ".local", "state", "aos-unattended-work", "openmausbot"));
  const launchAgentPath = argument("--launch-agent", join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`));
  for (const [value, label] of [[runtimeRoot, "runtime root"], [dataRoot, "data root"], [launchAgentPath, "launch agent"]]) {
    requireAbsoluteSafePath(value, label);
  }
  const appPort = validatePort(argument("--app-port", "8827"), "app port");
  const webhookPort = validatePort(argument("--webhook-port", "8828"), "webhook port");
  const planePort = validatePort(argument("--plane-port", "8817"), "plane port");
  if (new Set([appPort, webhookPort, planePort, 8799, 8800]).size !== 5) fail("isolated ports must be distinct from each other and the attended defaults");
  if (serviceIsLoaded()) fail("unattended OpenMausBot service is already loaded");

  if (realpathSync(ROOT) !== ROOT) fail("source worktree must not be reached through a symlink");
  const actualSha = run("git", ["rev-parse", "HEAD"]);
  if (actualSha !== expectedSha) fail(`source SHA changed: expected ${expectedSha}, found ${actualSha}`);
  if (run("git", ["status", "--porcelain=v1", "--untracked-files=all"])) fail("source worktree is not clean");

  // Build after validating the exact clean checkout. This binds every staged
  // executable artifact to expectedSha instead of trusting whatever an older
  // build happened to leave in ignored dist directories.
  run("pnpm", ["build"]);
  run("pnpm", ["build:server"]);
  if (run("git", ["rev-parse", "HEAD"]) !== expectedSha) fail("source SHA changed during build");
  if (run("git", ["status", "--porcelain=v1", "--untracked-files=all"])) {
    fail("source worktree changed during build");
  }
  for (const artifact of [join(ROOT, "dist", "unattended-work.html"), join(ROOT, "dist-server", "index.js")]) {
    if (!existsSync(artifact)) fail(`required build artifact is missing: ${artifact}`);
    requireOwnedTarget(artifact, "required build artifact", "regular file");
  }

  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  if (realpathSync(runtimeRoot) !== runtimeRoot || realpathSync(dataRoot) !== dataRoot) {
    fail("runtime and data roots must not be symlinks");
  }
  requireOwnedTarget(runtimeRoot, "runtime root", "directory");
  requireOwnedTarget(dataRoot, "data root", "directory");
  chmodSync(runtimeRoot, 0o700);
  chmodSync(dataRoot, 0o700);
  const generation = join(runtimeRoot, expectedSha);
  const receiptPath = join(generation, "receipt.json");
  if (existsSync(generation)) {
    requireOwnedTarget(generation, "runtime generation", "directory");
    requireOwnedTarget(receiptPath, "runtime receipt", "regular file");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (
      receipt.source_sha !== expectedSha ||
      receipt.schema !== "openmausbot.unattended-work-runtime.v1" ||
      receipt.app_port !== appPort ||
      receipt.webhook_port !== webhookPort ||
      receipt.plane_port !== planePort ||
      receipt.data_root !== dataRoot ||
      receipt.launch_agent_path !== launchAgentPath ||
      !receipt.node_path
    ) {
      fail("existing generation receipt does not match");
    }
    if (treeHash(generation, new Set(["receipt.json"])) !== receipt.artifact_sha256) {
      fail("existing generation artifact hash does not match");
    }
    const plist = launchAgent({
      node: receipt.node_path,
      server: join(generation, "server", "index.js"),
      staticDir: join(generation, "static"),
      dataRoot,
      appPort,
      webhookPort,
      planePort,
    });
    ensureLaunchAgent(launchAgentPath, plist);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  }

  const staging = mkdtempSync(join(runtimeRoot, ".staging-"));
  try {
    const staticDir = join(staging, "static");
    const serverDir = join(staging, "server");
    mkdirSync(staticDir, { mode: 0o700 });
    cpSync(join(ROOT, "dist", "unattended-work.html"), join(staticDir, "index.html"), { errorOnExist: true });
    cpSync(join(ROOT, "dist-server"), serverDir, { recursive: true, errorOnExist: true });
    run("git", ["archive", "--format=tar", `--output=${join(staging, "source.tar")}`, expectedSha]);
    const artifactSha = treeHash(staging);
    const receipt = {
      schema: "openmausbot.unattended-work-runtime.v1",
      source_sha: expectedSha,
      artifact_sha256: artifactSha,
      source_ready: true,
      dormant_ready: true,
      live_accepted: false,
      executor: "hermes",
      app_port: appPort,
      webhook_port: webhookPort,
      plane_port: planePort,
      adapter_only: true,
      openmausbot_ingress_enabled: false,
      dispatcher_enabled: false,
      telegram_delivery_enabled: false,
      provider_calls_enabled: false,
      launch_agent_label: LABEL,
      launch_agent_run_at_load: false,
      launch_agent_bootstrapped: false,
      installed_app_replaced: false,
      attended_data_modified: false,
      credential_values_included: false,
      node_path: process.execPath,
      data_root: dataRoot,
      launch_agent_path: launchAgentPath,
    };
    writeFileSync(join(staging, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o444 });
    removeWriteBits(staging);
    renameSync(staging, generation);

    const plist = launchAgent({
      node: process.execPath,
      server: join(generation, "server", "index.js"),
      staticDir: join(generation, "static"),
      dataRoot,
      appPort,
      webhookPort,
      planePort,
    });
    ensureLaunchAgent(launchAgentPath, plist);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
