import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { APPARMOR_PROFILE, LABELS, NAMES, PATHS, SECCOMP_FILE } from "../src/settings.ts";

const SCRIPT = join(import.meta.dirname, "..", "install.sh");
const script = readFileSync(SCRIPT, "utf8");
const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs install.sh with stand-ins for docker, id and apparmor_parser that record what they were asked to do. */
function run(args: string[], options: { uid?: number; env?: Record<string, string>; ownServer?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-install-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool("docker", `echo "docker $*" >> "${log}"
case "$*" in
  "ps -aq --filter label=${LABELS.role}=helper") echo helper-1 ;;
  "volume ls -q --filter label=${LABELS.role}=backup") echo obot-backup-20261028-000000-ab12; echo obot-backup-20261029-000000-cd34 ;;
esac`);
  tool("id", `echo ${options.uid ?? 0}`);
  tool("apparmor_parser", `echo "apparmor_parser $*" >> "${log}"`);
  const etc = join(dir, "etc-obot");
  const apparmor = join(dir, "apparmor.d");
  const audit = join(dir, "log-obot");
  mkdirSync(etc);
  mkdirSync(apparmor);
  mkdirSync(audit);
  writeFileSync(join(audit, "audit.jsonl"), "{}\n");
  writeFileSync(join(etc, SECCOMP_FILE), "{}");
  writeFileSync(join(apparmor, APPARMOR_PROFILE), "profile");
  const install = join(dir, "opt-obot");
  const update = join(dir, "update");
  const sbin = join(dir, "sbin");
  const systemd = join(dir, "systemd");
  for (const made of [install, join(install, "data"), update, sbin, systemd]) mkdirSync(made);
  if (options.ownServer) {
    writeFileSync(join(install, "compose.yaml"), "name: obot\n");
    writeFileSync(join(install, "data", "chats.json"), "theirs");
    for (const file of [join(update, "runner"), join(sbin, "obot-update-runner"), join(systemd, "obot-update.path"), join(systemd, "obot-update.service")]) writeFileSync(file, "1\n");
  }
  const result = spawnSync("sh", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`, OBOT_ETC_DIR: etc, OBOT_APPARMOR_DIR: apparmor, OBOT_AUDIT_DIR: audit,
      OBOT_INSTALL_DIR: install, OBOT_UPDATE_DIR: update, OBOT_SBIN_DIR: sbin, OBOT_SYSTEMD_DIR: systemd,
      OBOT_ADMIN_URL: "https://cloud.example.test", OBOT_CONNECTOR_IMAGE: `ghcr.io/alnatourm/obot-connector@sha256:${"1".repeat(64)}`,
      ...options.env,
    },
    timeout: 30_000,
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...result, calls, etc, apparmor, audit, install, update, sbin, systemd };
}

describe("install.sh", () => {
  it.skipIf(!posix)("is plain POSIX sh, as `curl … | sh` runs it", () => {
    expect(spawnSync("sh", ["-n", SCRIPT]).status).toBe(0);
    const dash = spawnSync("dash", ["-n", SCRIPT]);
    if (!dash.error) expect(dash.status).toBe(0);
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    for (const bashism of [/\[\[/, /\bfunction\s+\w+/, /\blocal\s/, /<<</, /\$\{[A-Za-z_]+\[/, /\bsource\s/, /&>/]) expect(script, String(bashism)).not.toMatch(bashism);
  });

  it("names the same Docker objects, labels and profiles as the connector, and waits for Obot to fill in its address and image", () => {
    const value = (name: string) => new RegExp(`^${name}=(\\S+)$`, "m").exec(script)?.[1];
    expect(value("CONNECTOR")).toBe(NAMES.connector);
    expect(value("CONNECTOR_NEXT")).toBe(NAMES.connectorNext);
    expect(value("HOME_CONTAINER")).toBe(NAMES.home);
    expect(value("DATA_VOLUME")).toBe(NAMES.dataVolume);
    expect(value("STATE_VOLUME")).toBe(NAMES.stateVolume);
    expect(value("SNAPSHOT_VOLUME")).toBe(NAMES.snapshotVolume);
    expect(value("ROLE_LABEL")).toBe(LABELS.role);
    expect(value("PROFILE")).toBe(APPARMOR_PROFILE);
    expect(value("SECCOMP")).toBe(SECCOMP_FILE);
    expect(script).toContain('ADMIN_URL="${OBOT_ADMIN_URL:-@OBOT_ADMIN_URL@}"');
    expect(script).toContain('CONNECTOR_IMAGE="${OBOT_CONNECTOR_IMAGE:-@OBOT_CONNECTOR_IMAGE@}"');
    expect(script).toContain(`say "Connected. Your server shows up in Obot in a minute, for your team's Owner to accept."`);
    expect(script).toContain(`com.obot.instance=$instance`);
    expect(script).toContain("--restart unless-stopped --network host");
    expect(script).toContain("-v /var/run/docker.sock:/var/run/docker.sock -v \"$STATE_VOLUME:/state\" -v \"$ETC_DIR:/etc/obot:ro\" -v \"$AUDIT_DIR:/var/log/obot\"");
    expect(script).toContain('AUDIT_DIR="${OBOT_AUDIT_DIR:-/var/log/obot}"');
    expect(PATHS.audit).toBe("/var/log/obot");
    expect(script).toContain('apparmor_parser -r -W "$APPARMOR_DIR/$PROFILE"');
  });

  it.skipIf(!posix)("uninstall stops everything but keeps the data, its safety copy and its backups", () => {
    const result = run(["uninstall"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual(expect.arrayContaining([
      `docker rm -f ${NAMES.connector} ${NAMES.connectorNext}`, `docker stop -t 30 ${NAMES.home}`, `docker rm -f ${NAMES.home}`, "docker rm -f helper-1",
      `docker volume rm ${NAMES.stateVolume}`,
    ]));
    expect(result.calls.filter((call) => /volume rm (obot-data|obot-snapshot|obot-backup-)/.test(call))).toEqual([]);
    expect(result.calls.some((call) => call.startsWith("apparmor_parser -R "))).toBe(true);
    expect(existsSync(join(result.apparmor, APPARMOR_PROFILE))).toBe(false);
    expect(existsSync(result.etc)).toBe(false);
    expect(result.stdout).toContain(`Your data is kept in the Docker volume ${NAMES.dataVolume}, with its backups, and the audit log in ${result.audit}.`);
    expect(existsSync(join(result.audit, "audit.jsonl"))).toBe(true);
    expect(result.stdout).toContain("curl -fsSL https://cloud.example.test/install.sh | sudo sh -s -- uninstall --delete-data");
  });

  it.skipIf(!posix)("deletes the data only when --delete-data is typed, and refuses anything else before touching a thing", () => {
    const deleted = run(["uninstall", "--delete-data"]);
    expect(deleted.status, deleted.stderr).toBe(0);
    expect(deleted.calls).toEqual(expect.arrayContaining([
      `docker volume rm ${NAMES.dataVolume}`, `docker volume rm ${NAMES.snapshotVolume}`,
      "docker volume rm obot-backup-20261028-000000-ab12", "docker volume rm obot-backup-20261029-000000-cd34",
    ]));
    expect(deleted.stdout).toContain("Obot is removed from this server, and so is its data.");
    expect(existsSync(deleted.audit)).toBe(false);
    for (const typo of [["uninstall", "--delete-dat"], ["uninstall", "--delete-data=yes"], ["uninstall", "-f"]]) {
      const refused = run(typo);
      expect(refused.status, typo.join(" ")).toBe(1);
      expect(refused.calls, typo.join(" ")).toEqual([]);
      expect(refused.stderr).toContain("Unknown option");
    }
  });

  it.skipIf(!posix)("says in plain words what to run instead: as root, from Obot's own command, with a code as Obot shows it", () => {
    const user = run(["MB-1A2B-3C4D"], { uid: 1000 });
    expect(user.status).toBe(1);
    expect(user.stderr).toContain("Please run this as root: put sudo before sh, like this: curl -fsSL https://cloud.example.test/install.sh | sudo sh -s -- MB-1A2B-3C4D");
    expect(run(["uninstall"], { uid: 1000 }).stderr).toContain("Please run this as root");
    const copied = run(["MB-1A2B-3C4D"], { env: { OBOT_ADMIN_URL: "", OBOT_CONNECTOR_IMAGE: "" } });
    expect(copied.stderr).toContain("This installer was not downloaded from Obot. Copy the install command from Obot and run that.");
    const odd = run(["MB-1A2B;reboot"]);
    expect(odd.stderr).toContain("That code doesn't look right. Copy the install command from Obot again.");
    expect(odd.calls).toEqual([]);
  });

  it("starts a customer-run connector with its mode and the updater's folder, and only where Obot is already installed", () => {
    expect(script).toContain('set -- "$@" -e OBOT_MODE=customer-run -v "$UPDATE_DIR:/var/lib/obot/update"');
    expect(PATHS.update).toBe("/var/lib/obot/update");
    expect(script).toContain('INSTALL_DIR="${OBOT_INSTALL_DIR:-/opt/obot}"');
    expect(script).toContain("PathExists=$UPDATE_DIR/request");
    expect(script).toContain("ExecStart=$SBIN_DIR/$UPDATE_RUNNER");
  });

  it.skipIf(!posix)("refuses --customer-run where Obot is not installed, before touching a thing", () => {
    const refused = run(["--customer-run", "MB-1A2B-3C4D"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`Obot isn't installed in ${refused.install} yet. Install it first with the server's install command, then run this again to connect it.`);
    expect(refused.calls).toEqual([]);
  });

  it.skipIf(!posix)("disconnecting a server its owner installed removes the connector and the updater, and leaves that Obot and its data alone", () => {
    const result = run(["uninstall", "--delete-data"], { ownServer: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(`docker rm -f ${NAMES.connector} ${NAMES.connectorNext}`);
    expect(result.calls.filter((call) => /obot-home|obot-data|obot|compose/.test(call))).toEqual([]);
    expect(readFileSync(join(result.install, "data", "chats.json"), "utf8")).toBe("theirs");
    expect(existsSync(join(result.install, "compose.yaml"))).toBe(true);
    for (const gone of [result.update, join(result.sbin, "obot-update-runner"), join(result.systemd, "obot-update.path"), join(result.systemd, "obot-update.service")]) expect(existsSync(gone), gone).toBe(false);
    expect(result.stdout).toContain(`Your Obot in ${result.install} and its data were not touched, and it keeps running.`);
    expect(existsSync(join(result.apparmor, APPARMOR_PROFILE))).toBe(true);
  });
});

