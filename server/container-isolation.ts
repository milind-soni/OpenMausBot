// The isolation contract every desktop container is made with and checked against: capabilities, the root rule, host ids.
import type { Runtime } from "./container-computer.ts";
import { MAX_DESKTOP_CPUS, MIN_DESKTOP_CPUS, MIN_DESKTOP_MEMORY_GB } from "./container-limits.ts";

/** The run flags a desktop was made with. A desktop made under other flags is updated like one on an older image. */
export const DESKTOP_FLAGS_LABEL = "com.openmausbot.desktop-flags";
export const DESKTOP_FLAGS_VERSION = "2";

const GIB = 1024 * 1024 * 1024;
export const GUEST_UID = 1000;
/** What supervisord needs to start each program as cua. */
const SUPERVISOR_CAPS = ["SETGID", "SETUID"];
/** apt and dpkg also need these to install a package as root (measured on Debian 12: without DAC_OVERRIDE every download fails). */
const PACKAGE_INSTALL_CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", ...SUPERVISOR_CAPS];
/** The only capability sets a hardened desktop may hold; one made with just SUPERVISOR_CAPS is sealed but cannot install packages. */
const HARDENED_CAP_SETS = [SUPERVISOR_CAPS, PACKAGE_INSTALL_CAPS];
/** The pinned base image's own CMD (trycua/xfce-cua 0.1.0). */
const SUPERVISORD = "/usr/bin/supervisord -c /etc/supervisor/supervisord.conf";
/** Runs as PID 1 before supervisord and gives cua the host workspace owner's ids. Files move before /etc/passwd does, so a
 * start interrupted mid-way finds the old ids again and finishes; it fails closed if /etc/passwd did not take them. */
const GUEST_IDS_SCRIPT = [
  "set -eu",
  'uid="$1"; gid="$2"; old_uid="$(id -u cua)"; old_gid="$(id -g cua)"',
  'if [ "$old_uid:$old_gid" != "$uid:$gid" ]; then',
  // The bind-mounted workspace is another filesystem, so -xdev from / skips it: an older desktop's files there move too.
  // Best effort: a share that refuses chown must not keep the desktop from starting.
  '  [ ! -d /home/cua/workspace ] || find /home/cua/workspace -xdev -uid "$old_uid" -exec chown -h "$uid" {} + || echo "some workspace files kept uid $old_uid" >&2',
  '  [ ! -d /home/cua/workspace ] || find /home/cua/workspace -xdev -gid "$old_gid" -exec chgrp -h "$gid" {} + || echo "some workspace files kept gid $old_gid" >&2',
  '  find / -xdev -uid "$old_uid" -exec chown -h "$uid" {} +',
  '  find / -xdev -gid "$old_gid" -exec chgrp -h "$gid" {} +',
  '  sed -i "s/^cua:x:$old_uid:$old_gid:/cua:x:$uid:$gid:/" /etc/passwd',
  '  sed -i "s/^cua:x:$old_gid:/cua:x:$gid:/" /etc/group',
  '  [ "$(id -u cua):$(id -g cua)" = "$uid:$gid" ] || { echo "cua did not take uid $uid gid $gid" >&2; exit 1; }',
  "fi",
  `exec ${SUPERVISORD}`,
].join("\n");

export function guestIdsCommand(ids: HostUser): string[] {
  return ["sh", "-c", GUEST_IDS_SCRIPT, "openmausbot-desktop", String(ids.uid), String(ids.gid)];
}

/** Docker Engine on Linux, and Podman run by root (whose keep-id is the host's own id map), run the desktop's root as the
 * host's root, so nothing in the desktop may gain root there (no-new-privileges). */
export function desktopRootIsHostRoot(runtime: Runtime | null, platform: NodeJS.Platform, host: HostUser | null): boolean {
  return platform === "linux" && (runtime === "docker" || (runtime === "podman" && host?.uid === 0));
}

export interface HostUser {
  uid: number;
  gid: number;
}

export function currentHostUser(platform: NodeJS.Platform): HostUser | null {
  return platform === "win32" || !process.getuid || !process.getgid ? null : { uid: process.getuid(), gid: process.getgid() };
}

/** Docker Engine keeps host ids, so cua takes the workspace owner's. A root-run server hands its workspace to cua
 * instead, so cua never takes uid 0 or gid 0. */
export function guestIdsFor(runtime: Runtime, platform: NodeJS.Platform, host: HostUser | null): HostUser | null {
  if (runtime !== "docker" || platform !== "linux" || !host || host.uid === 0 || host.uid === GUEST_UID) return null;
  return { uid: host.uid, gid: host.gid === 0 ? GUEST_UID : host.gid };
}

/** Apple container defaults to 1 GiB, below any limit this server sets, so a desktop made without our flags fails here. */
export function appleResourcesAreLimited(resources: { cpus?: number; memoryInBytes?: number } | undefined): boolean {
  const cpus = resources?.cpus ?? 0;
  return (resources?.memoryInBytes ?? 0) >= MIN_DESKTOP_MEMORY_GB * GIB &&
    Number.isInteger(cpus) && cpus >= MIN_DESKTOP_CPUS && cpus <= MAX_DESKTOP_CPUS;
}

export interface DockerHardeningConfig {
  Memory?: number;
  MemorySwap?: number;
  NanoCpus?: number;
  PidsLimit?: number | null;
  CapDrop?: string[] | null;
  CapAdd?: string[] | null;
  Privileged?: boolean;
  PidMode?: string;
  IpcMode?: string;
  UTSMode?: string;
  ShmSize?: number;
  Devices?: unknown[] | null;
  DeviceRequests?: unknown[] | null;
  SecurityOpt?: string[] | null;
  UsernsMode?: string;
  CgroupnsMode?: string;
  OomKillDisable?: boolean | null;
  AutoRemove?: boolean;
  RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
}

function capSetKey(caps: string[] | null | undefined): string {
  return (caps ?? []).map((cap) => cap.toLowerCase().replace(/^cap_/, "")).sort().join(",");
}

function isHardenedCapSet(caps: string[] | null | undefined, podmanBrowserSandbox: boolean): boolean {
  const key = capSetKey(caps);
  return HARDENED_CAP_SETS.some((set) => capSetKey(podmanBrowserSandbox ? [...set, "SYS_CHROOT"] : set) === key);
}

export function desktopCapArgs(runtime: Runtime): string[] {
  // Podman's default seccomp profile gates chroot on this capability, and Firefox chroots to build its sandbox.
  const caps = runtime === "podman" ? [...PACKAGE_INSTALL_CAPS, "SYS_CHROOT"] : PACKAGE_INSTALL_CAPS;
  return ["--cap-drop", "ALL", ...caps.flatMap((cap) => ["--cap-add", cap])];
}

/** Shared isolation contract for Local VM and VPS containers; Podman alone needs chroot for Firefox's sandbox. */
export function dockerSecurityIsHardened(
  config: DockerHardeningConfig | undefined,
  options: {
    restartPolicy?: "no" | "unless-stopped" | "any";
    podmanBrowserSandbox?: boolean;
    requireNoNewPrivileges?: boolean;
  } = {},
): boolean {
  if (!config) return false;
  const capDrop = (config.CapDrop ?? []).map((cap) => cap.toLowerCase());
  const noNewPrivileges = (config.SecurityOpt ?? []).some((option) => /^no-new-privileges(?:[:=]true)?$/i.test(option));
  const unsafeSecurityOption = (config.SecurityOpt ?? []).some((option) => /(?:^|=)(?:unconfined|disable)$/i.test(option));
  const restartPolicy = config.RestartPolicy?.Name;
  const restartPolicyOk =
    options.restartPolicy === "any" || (options.restartPolicy === "unless-stopped"
      ? restartPolicy === "unless-stopped"
      : restartPolicy === undefined || restartPolicy === "" || restartPolicy === "no");
  return (
    capDrop.includes("all") &&
    isHardenedCapSet(config.CapAdd, options.podmanBrowserSandbox === true) &&
    (options.requireNoNewPrivileges !== true || noNewPrivileges) &&
    config.Privileged === false &&
    !config.PidMode &&
    config.IpcMode === "private" &&
    !config.UTSMode &&
    (!config.Devices || config.Devices.length === 0) &&
    (!config.DeviceRequests || config.DeviceRequests.length === 0) &&
    !unsafeSecurityOption &&
    !config.UsernsMode &&
    config.CgroupnsMode === "private" &&
    config.AutoRemove !== true &&
    restartPolicyOk
  );
}

/** Podman normalizes HostConfig capability and namespace fields in inspect output, so its effective/bounding sets decide. */
export function podmanSecurityIsHardened(
  config: DockerHardeningConfig | undefined,
  effectiveCaps: string[] | undefined,
  boundingCaps: string[] | undefined,
  options: { requireNoNewPrivileges?: boolean } = {},
): boolean {
  if (!config) return false;
  if (!isHardenedCapSet(effectiveCaps, true) || capSetKey(boundingCaps) !== capSetKey(effectiveCaps)) return false;
  return dockerSecurityIsHardened({
    ...config,
    CapDrop: ["all"],
    CapAdd: effectiveCaps,
    PidMode: config.PidMode === "private" ? "" : config.PidMode,
    UTSMode: config.UTSMode === "private" ? "" : config.UTSMode,
    // Rootless keep-id maps the workspace owner to the guest cua account; never arbitrary userns sharing or host namespaces.
    UsernsMode: config.UsernsMode === "private" || config.UsernsMode === "keep-id:uid=1000,gid=1000"
      ? "" : config.UsernsMode,
    CgroupnsMode: config.CgroupnsMode || "private",
  }, { podmanBrowserSandbox: true, requireNoNewPrivileges: options.requireNoNewPrivileges });
}
