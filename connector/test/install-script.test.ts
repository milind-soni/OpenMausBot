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
  "volume ls -q --filter label=${LABELS.role}=backup") echo indbot-backup-20261028-000000-ab12; echo indbot-backup-20261029-000000-cd34 ;;
esac`);
  tool("id", `echo ${options.uid ?? 0}`);
  tool("apparmor_parser", `echo "apparmor_parser $*" >> "${log}"`);
  const etc = join(dir, "etc-indbot");
  const apparmor = join(dir, "apparmor.d");
  const audit = join(dir, "log-indbot");
  mkdirSync(etc);
  mkdirSync(apparmor);
  mkdirSync(audit);
  writeFileSync(join(audit, "audit.jsonl"), "{}\n");
  writeFileSync(join(etc, SECCOMP_FILE), "{}");
  writeFileSync(join(apparmor, APPARMOR_PROFILE), "profile");
  const install = join(dir, "opt-openindbot");
  const update = join(dir, "update");
  const sbin = join(dir, "sbin");
  const systemd = join(dir, "systemd");
  for (const made of [install, join(install, "data"), update, sbin, systemd]) mkdirSync(made);
  if (options.ownServer) {
    writeFileSync(join(install, "compose.yaml"), "name: openindbot\n");
    writeFileSync(join(install, "data", "chats.json"), "theirs");
    for (const file of [join(update, "runner"), join(sbin, "indbot-update-runner"), join(systemd, "indbot-update.path"), join(systemd, "indbot-update.service")]) writeFileSync(file, "1\n");
  }
  const result = spawnSync("sh", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`, INDBOT_ETC_DIR: etc, INDBOT_APPARMOR_DIR: apparmor, INDBOT_AUDIT_DIR: audit,
      INDBOT_INSTALL_DIR: install, INDBOT_UPDATE_DIR: update, INDBOT_SBIN_DIR: sbin, INDBOT_SYSTEMD_DIR: systemd,
      INDBOT_ADMIN_URL: "https://cloud.example.test", INDBOT_CONNECTOR_IMAGE: `ghcr.io/milind-soni/indbot-connector@sha256:${"1".repeat(64)}`,
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

  it("names the same Docker objects, labels and profiles as the connector, and waits for IndBot to fill in its address and image", () => {
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
    expect(script).toContain('ADMIN_URL="${INDBOT_ADMIN_URL:-@INDBOT_ADMIN_URL@}"');
    expect(script).toContain('CONNECTOR_IMAGE="${INDBOT_CONNECTOR_IMAGE:-@INDBOT_CONNECTOR_IMAGE@}"');
    expect(script).toContain(`say "Connected. Your server shows up in IndBot in a minute, for your team's Owner to accept."`);
    expect(script).toContain(`com.indbot.instance=$instance`);
    expect(script).toContain("--restart unless-stopped --network host");
    expect(script).toContain("-v /var/run/docker.sock:/var/run/docker.sock -v \"$STATE_VOLUME:/state\" -v \"$ETC_DIR:/etc/indbot:ro\" -v \"$AUDIT_DIR:/var/log/indbot\"");
    expect(script).toContain('AUDIT_DIR="${INDBOT_AUDIT_DIR:-/var/log/indbot}"');
    expect(PATHS.audit).toBe("/var/log/indbot");
    expect(script).toContain('apparmor_parser -r -W "$APPARMOR_DIR/$PROFILE"');
  });

  it.skipIf(!posix)("uninstall stops everything but keeps the data, its safety copy and its backups", () => {
    const result = run(["uninstall"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual(expect.arrayContaining([
      `docker rm -f ${NAMES.connector} ${NAMES.connectorNext}`, `docker stop -t 30 ${NAMES.home}`, `docker rm -f ${NAMES.home}`, "docker rm -f helper-1",
      `docker volume rm ${NAMES.stateVolume}`,
    ]));
    expect(result.calls.filter((call) => /volume rm (indbot-data|indbot-snapshot|indbot-backup-)/.test(call))).toEqual([]);
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
      "docker volume rm indbot-backup-20261028-000000-ab12", "docker volume rm indbot-backup-20261029-000000-cd34",
    ]));
    expect(deleted.stdout).toContain("IndBot is removed from this server, and so is its data.");
    expect(existsSync(deleted.audit)).toBe(false);
    for (const typo of [["uninstall", "--delete-dat"], ["uninstall", "--delete-data=yes"], ["uninstall", "-f"]]) {
      const refused = run(typo);
      expect(refused.status, typo.join(" ")).toBe(1);
      expect(refused.calls, typo.join(" ")).toEqual([]);
      expect(refused.stderr).toContain("Unknown option");
    }
  });

  it.skipIf(!posix)("says in plain words what to run instead: as root, from IndBot's own command, with a code as IndBot shows it", () => {
    const user = run(["MB-1A2B-3C4D"], { uid: 1000 });
    expect(user.status).toBe(1);
    expect(user.stderr).toContain("Please run this as root: put sudo before sh, like this: curl -fsSL https://cloud.example.test/install.sh | sudo sh -s -- MB-1A2B-3C4D");
    expect(run(["uninstall"], { uid: 1000 }).stderr).toContain("Please run this as root");
    const copied = run(["MB-1A2B-3C4D"], { env: { INDBOT_ADMIN_URL: "", INDBOT_CONNECTOR_IMAGE: "" } });
    expect(copied.stderr).toContain("This installer was not downloaded from IndBot. Copy the install command from IndBot and run that.");
    const odd = run(["MB-1A2B;reboot"]);
    expect(odd.stderr).toContain("That code doesn't look right. Copy the install command from IndBot again.");
    expect(odd.calls).toEqual([]);
  });

  it("starts a customer-run connector with its mode and the updater's folder, and only where IndBot is already installed", () => {
    expect(script).toContain('set -- "$@" -e INDBOT_MODE=customer-run -v "$UPDATE_DIR:/var/lib/indbot/update"');
    expect(PATHS.update).toBe("/var/lib/indbot/update");
    expect(script).toContain('INSTALL_DIR="${INDBOT_INSTALL_DIR:-/opt/openindbot}"');
    expect(script).toContain("PathExists=$UPDATE_DIR/request");
    expect(script).toContain("ExecStart=$SBIN_DIR/$UPDATE_RUNNER");
  });

  it.skipIf(!posix)("refuses --customer-run where IndBot is not installed, before touching a thing", () => {
    const refused = run(["--customer-run", "MB-1A2B-3C4D"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`IndBot isn't installed in ${refused.install} yet. Install it first with the server's install command, then run this again to connect it.`);
    expect(refused.calls).toEqual([]);
  });

  it.skipIf(!posix)("disconnecting a server its owner installed removes the connector and the updater, and leaves that IndBot and its data alone", () => {
    const result = run(["uninstall", "--delete-data"], { ownServer: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(`docker rm -f ${NAMES.connector} ${NAMES.connectorNext}`);
    expect(result.calls.filter((call) => /indbot-home|indbot-data|openindbot|compose/.test(call))).toEqual([]);
    expect(readFileSync(join(result.install, "data", "chats.json"), "utf8")).toBe("theirs");
    expect(existsSync(join(result.install, "compose.yaml"))).toBe(true);
    for (const gone of [result.update, join(result.sbin, "indbot-update-runner"), join(result.systemd, "indbot-update.path"), join(result.systemd, "indbot-update.service")]) expect(existsSync(gone), gone).toBe(false);
    expect(result.stdout).toContain(`Your IndBot in ${result.install} and its data were not touched, and it keeps running.`);
    expect(existsSync(join(result.apparmor, APPARMOR_PROFILE))).toBe(true);
  });
});
