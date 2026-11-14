// Which mount points may be shared as a whole drive, so an external disk is one choice instead of one folder at a time.
//
// A drive is shareable only when it is clearly a separate disk and not the computer itself: never the system volume,
// never anything that holds the home folder (the caller refuses those first, by filesystem identity), never a system
// directory that happens to be its own partition, and never a virtual filesystem. The decision is made on the
// canonical path the OS resolved, so a symlink to a drive is judged by where it ends up.
import fsp from "node:fs/promises";
import path from "node:path";

/** Linux filesystems that live on a real disk or network share. tmpfs, proc, sysfs, overlay, squashfs, cgroup and the
 * desktop's fuse portals are not on this list, so they are never a drive. */
const LINUX_DISK_FILESYSTEMS = new Set([
  "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "jfs", "reiserfs", "ntfs", "ntfs3", "fuseblk", "fuse.ntfs-3g",
  "fuse.exfat", "exfat", "vfat", "msdos", "hfsplus", "udf", "iso9660", "nfs", "nfs4", "cifs", "smb3",
]);
/** Directories that hold the system itself. A disk mounted at or under one of these is part of the system, not a drive
 * the person plugged in. */
const LINUX_SYSTEM_DIRECTORIES = ["/boot", "/efi", "/usr", "/var", "/etc", "/opt", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/root", "/proc", "/sys", "/dev", "/run/user", "/snap"];

const inside = (candidate, directory) => candidate === directory || candidate.startsWith(`${directory}/`);

/** /proc/self/mountinfo escapes space, tab, newline and backslash in a mount point as \040 \011 \012 \134. */
const unescapeMountPoint = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

/** [{ mountPoint, filesystem }] from the text of /proc/self/mountinfo. Lines that do not parse are skipped. */
export function parseMountInfo(text) {
  const mounts = [];
  for (const line of String(text).split("\n")) {
    const dash = line.indexOf(" - ");
    if (dash < 0) continue;
    const before = line.slice(0, dash).split(" ");
    const after = line.slice(dash + 3).split(" ");
    if (before.length < 5 || !after[0]) continue;
    mounts.push({ mountPoint: unescapeMountPoint(before[4]), filesystem: after[0] });
  }
  return mounts;
}

/** Whether `canonical` is a mount point of a real disk on Linux outside the system directories. A data disk on a
 * server (/data, /srv/archive, /mnt/backup) and a removable one (/media/me/USB, /run/media/me/USB) both qualify. */
export function linuxDrive(canonical, mounts) {
  if (canonical === "/" || LINUX_SYSTEM_DIRECTORIES.some(directory => inside(canonical, directory))) return false;
  return mounts.some(mount => mount.mountPoint === canonical && LINUX_DISK_FILESYSTEMS.has(mount.filesystem));
}

/** Whether `canonical` is the root of a drive that may be shared whole. Pure: `mounts` is the Linux mount table. */
export function isShareableDriveRoot(canonical, platform = process.platform, mounts = []) {
  if (typeof canonical !== "string" || !(platform === "win32" ? path.win32 : path.posix).isAbsolute(canonical)) return false;
  // macOS: every disk, disk image and network share the person mounted appears directly under /Volumes. The startup
  // disk's own entry there is a link to "/", which the caller has already refused.
  if (platform === "darwin") return path.posix.dirname(canonical) === "/Volumes" && path.posix.basename(canonical).length > 0;
  // Windows: a drive letter. The drive that holds the home folder was refused before this is asked.
  if (platform === "win32") return /^[A-Za-z]:\\$/.test(canonical);
  return linuxDrive(canonical, mounts);
}

export async function readLinuxMounts() {
  try { return parseMountInfo(await fsp.readFile("/proc/self/mountinfo", "utf8")); } catch { return []; }
}

/** The check validateSharedFolders makes for a path that is a volume root. Unreadable mount tables fail closed. */
export async function shareableDrive(canonical, platform = process.platform, readMounts = readLinuxMounts) {
  return isShareableDriveRoot(canonical, platform, platform === "linux" ? await readMounts() : []);
}
