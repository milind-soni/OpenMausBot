import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { APPARMOR_PROFILE, LABELS, NAMES, SECCOMP_FILE } from "../src/settings.ts";

const SCRIPT = join(import.meta.dirname, "..", "install.sh");
const script = readFileSync(SCRIPT, "utf8");
const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs install.sh with stand-ins for docker, id and apparmor_parser that record what they were asked to do. */
function run(args: string[], options: { uid?: number; env?: Record<string, string> } = {}) {
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
  "volume ls -q --filter label=${LABELS.role}=backup") echo mausbot-backup-20261028-000000-ab12; echo mausbot-backup-20261029-000000-cd34 ;;
esac`);
  tool("id", `echo ${options.uid ?? 0}`);
  tool("apparmor_parser", `echo "apparmor_parser $*" >> "${log}"`);
  const etc = join(dir, "etc-mausbot");
  const apparmor = join(dir, "apparmor.d");
  mkdirSync(etc);
  mkdirSync(apparmor);
  writeFileSync(join(etc, SECCOMP_FILE), "{}");
  writeFileSync(join(apparmor, APPARMOR_PROFILE), "profile");
  const result = spawnSync("sh", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`, MAUSBOT_ETC_DIR: etc, MAUSBOT_APPARMOR_DIR: apparmor,
      MAUSBOT_ADMIN_URL: "https://cloud.example.test", MAUSBOT_CONNECTOR_IMAGE: `ghcr.io/milind-soni/mausbot-connector@sha256:${"1".repeat(64)}`,
      ...options.env,
    },
    timeout: 30_000,
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...result, calls, etc, apparmor };
}

describe("install.sh", () => {
  it.skipIf(!posix)("is plain POSIX sh, as `curl … | sh` runs it", () => {
    expect(spawnSync("sh", ["-n", SCRIPT]).status).toBe(0);
    const dash = spawnSync("dash", ["-n", SCRIPT]);
    if (!dash.error) expect(dash.status).toBe(0);
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    for (const bashism of [/\[\[/, /\bfunction\s+\w+/, /\blocal\s/, /<<</, /\$\{[A-Za-z_]+\[/, /\bsource\s/, /&>/]) expect(script, String(bashism)).not.toMatch(bashism);
  });

  it("names the same Docker objects, labels and profiles as the connector, and waits for MausBot to fill in its address and image", () => {
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
    expect(script).toContain('ADMIN_URL="${MAUSBOT_ADMIN_URL:-@MAUSBOT_ADMIN_URL@}"');
    expect(script).toContain('CONNECTOR_IMAGE="${MAUSBOT_CONNECTOR_IMAGE:-@MAUSBOT_CONNECTOR_IMAGE@}"');
    expect(script).toContain('say "Connected. Your server shows up in MausBot in a minute."');
    expect(script).toContain(`com.mausbot.instance=$instance`);
    expect(script).toContain("--restart unless-stopped --network host");
    expect(script).toContain("-v /var/run/docker.sock:/var/run/docker.sock -v \"$STATE_VOLUME:/state\" -v \"$ETC_DIR:/etc/mausbot:ro\"");
    expect(script).toContain('apparmor_parser -r -W "$APPARMOR_DIR/$PROFILE"');
  });

  it.skipIf(!posix)("uninstall stops everything but keeps the data, its safety copy and its backups", () => {
    const result = run(["uninstall"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual(expect.arrayContaining([
      `docker rm -f ${NAMES.connector} ${NAMES.connectorNext}`, `docker stop -t 30 ${NAMES.home}`, `docker rm -f ${NAMES.home}`, "docker rm -f helper-1",
      `docker volume rm ${NAMES.stateVolume}`,
    ]));
    expect(result.calls.filter((call) => /volume rm (mausbot-data|mausbot-snapshot|mausbot-backup-)/.test(call))).toEqual([]);
    expect(result.calls.some((call) => call.startsWith("apparmor_parser -R "))).toBe(true);
    expect(existsSync(join(result.apparmor, APPARMOR_PROFILE))).toBe(false);
    expect(existsSync(result.etc)).toBe(false);
    expect(result.stdout).toContain(`Your data is kept in the Docker volume ${NAMES.dataVolume}, with its backups.`);
    expect(result.stdout).toContain("curl -fsSL https://cloud.example.test/install.sh | sudo sh -s -- uninstall --delete-data");
  });

  it.skipIf(!posix)("deletes the data only when --delete-data is typed, and refuses anything else before touching a thing", () => {
    const deleted = run(["uninstall", "--delete-data"]);
    expect(deleted.status, deleted.stderr).toBe(0);
    expect(deleted.calls).toEqual(expect.arrayContaining([
      `docker volume rm ${NAMES.dataVolume}`, `docker volume rm ${NAMES.snapshotVolume}`,
      "docker volume rm mausbot-backup-20261028-000000-ab12", "docker volume rm mausbot-backup-20261029-000000-cd34",
    ]));
    expect(deleted.stdout).toContain("MausBot is removed from this server, and so is its data.");
    for (const typo of [["uninstall", "--delete-dat"], ["uninstall", "--delete-data=yes"], ["uninstall", "-f"]]) {
      const refused = run(typo);
      expect(refused.status, typo.join(" ")).toBe(1);
      expect(refused.calls, typo.join(" ")).toEqual([]);
      expect(refused.stderr).toContain("Unknown option");
    }
  });

  it.skipIf(!posix)("says in plain words what to run instead: as root, from MausBot's own command, with a code as MausBot shows it", () => {
    const user = run(["MB-1A2B-3C4D"], { uid: 1000 });
    expect(user.status).toBe(1);
    expect(user.stderr).toContain("Please run this as root: put sudo before sh, like this: curl -fsSL https://cloud.example.test/install.sh | sudo sh -s -- MB-1A2B-3C4D");
    expect(run(["uninstall"], { uid: 1000 }).stderr).toContain("Please run this as root");
    const copied = run(["MB-1A2B-3C4D"], { env: { MAUSBOT_ADMIN_URL: "", MAUSBOT_CONNECTOR_IMAGE: "" } });
    expect(copied.stderr).toContain("This installer was not downloaded from MausBot. Copy the install command from MausBot and run that.");
    const odd = run(["MB-1A2B;reboot"]);
    expect(odd.stderr).toContain("That code doesn't look right. Copy the install command from MausBot again.");
    expect(odd.calls).toEqual([]);
  });
});
