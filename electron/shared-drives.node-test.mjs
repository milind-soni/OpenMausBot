import assert from "node:assert/strict";
import test from "node:test";
import { isShareableDriveRoot, isSystemDrive, linuxDrive, parseMountInfo, shareableDrive } from "./shared-drives.mjs";

const MOUNTINFO = [
  "25 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw",
  "26 25 259:1 / /boot/efi rw,relatime shared:2 - vfat /dev/nvme0n1p1 rw",
  "27 25 0:23 / /run/user/1000 rw,nosuid shared:3 - tmpfs tmpfs rw",
  "28 25 8:17 / /data rw,relatime shared:4 - ext4 /dev/sdb1 rw",
  "29 25 8:33 / /mnt/backup\\040disk rw,relatime shared:5 - xfs /dev/sdc1 rw",
  "30 25 8:49 / /media/me/USB rw,relatime shared:6 - exfat /dev/sdd1 rw",
  "31 25 8:65 / /var/lib/postgres rw,relatime shared:7 - ext4 /dev/sde1 rw",
  "32 25 0:40 / /srv/overlay rw,relatime shared:8 - overlay overlay rw",
  "garbage line without separator",
].join("\n");

test("parseMountInfo reads mount points and filesystems, unescapes spaces, skips junk", () => {
  const mounts = parseMountInfo(MOUNTINFO);
  assert.equal(mounts.length, 8);
  assert.deepEqual(mounts.find(m => m.mountPoint === "/mnt/backup disk"), { mountPoint: "/mnt/backup disk", filesystem: "xfs" });
});

test("Linux: data and removable disks are drives; the system, system directories and virtual filesystems are not", () => {
  const mounts = parseMountInfo(MOUNTINFO);
  for (const ok of ["/data", "/mnt/backup disk", "/media/me/USB"]) assert.equal(linuxDrive(ok, mounts), true, ok);
  for (const no of ["/", "/boot/efi", "/run/user/1000", "/var/lib/postgres", "/srv/overlay", "/data/sub", "/nowhere"]) assert.equal(linuxDrive(no, mounts), false, no);
});

test("macOS: only a direct child of /Volumes is a drive", () => {
  assert.equal(isShareableDriveRoot("/Volumes/External2TB", "darwin"), true);
  for (const no of ["/Volumes", "/Volumes/External2TB/Folder", "/Users/me", "/", "relative"]) assert.equal(isShareableDriveRoot(no, "darwin"), false, no);
});

test("Windows: only a bare drive letter is a drive", () => {
  assert.equal(isShareableDriveRoot("D:\\", "win32"), true);
  for (const no of ["D:\\Folder", "\\\\server\\share", "D:"]) assert.equal(isShareableDriveRoot(no, "win32"), false, no);
});

test("shareableDrive fails closed when the Linux mount table is unreadable", async () => {
  assert.equal(await shareableDrive("/data", "linux", async () => []), false);
  assert.equal(await shareableDrive("/data", "linux", async () => parseMountInfo(MOUNTINFO)), true);
});

test("the home folder is lent only when asked for by the picker; its parents and the system disk never are", async () => {
  const { mkdtempSync, mkdirSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { validateSharedFolders, isHomeFolder } = await import("./computer-sharing.mjs");
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "omb-home-opt-in-")));
  const home = path.join(base, "me");
  mkdirSync(path.join(home, "Documents"), { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const id = "8b0c8d3e-1f2a-4b5c-8d6e-7f8091a2b3c4";
  try {
    process.env.HOME = home; process.env.USERPROFILE = home;
    assert.equal(await isHomeFolder(home), true);
    assert.equal(await isHomeFolder(path.join(home, "Documents")), false);
    await assert.rejects(validateSharedFolders([{ id, path: home, write: false }]), { code: "HOME_OR_ROOT" }, "not without the request");
    const [lent] = await validateSharedFolders([{ id, path: home, write: true, home: true }]);
    assert.equal(lent.home, true);
    assert.equal(lent.write, false, "the home folder is read only even when edits are asked for");
    // The flag buys nothing for any other folder, for a parent of home, or for the system disk.
    await assert.rejects(validateSharedFolders([{ id, path: base, write: false, home: true }]), { code: "HOME_OR_ROOT" });
    // The system disk is the one the home folder is on: "/" here, its drive letter on Windows. A bare "/" there is the
    // current drive's root, which on CI (D:\, the checkout) is a separate data drive and may be shared whole.
    await assert.rejects(validateSharedFolders([{ id, path: path.parse(home).root, write: false, home: true }]), { code: "HOME_OR_ROOT" });
    const [docs] = await validateSharedFolders([{ id, path: path.join(home, "Documents"), write: false, home: true }]);
    assert.equal(docs.home, undefined);
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(base, { recursive: true, force: true });
  }
});

test("the Windows system drive is lent whole only when the picker asks for it, read only until edits are confirmed", async () => {
  const { mkdtempSync, mkdirSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { validateSharedFolders } = await import("./computer-sharing.mjs");
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "omb-system-drive-")));
  const home = path.join(base, "me");
  mkdirSync(home, { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const id = "8b0c8d3e-1f2a-4b5c-8d6e-7f8091a2b3c4";
  // The drive the home folder is on: C:\ on Windows; "/" here, standing in for it with platform "win32".
  const drive = path.parse(home).root;
  try {
    process.env.HOME = home; process.env.USERPROFILE = home;
    assert.equal(await isSystemDrive(drive, "win32"), true);
    assert.equal(await isSystemDrive(drive, "darwin"), false, "Windows only");
    assert.equal(await isSystemDrive(base, "win32"), false, "a folder, not the drive");
    const asked = { id, path: drive, write: true, system: true };
    const [lent] = await validateSharedFolders([asked], { platform: "win32" });
    assert.deepEqual({ system: lent.system, write: lent.write, home: lent.home }, { system: true, write: false, home: undefined });
    const [edits] = await validateSharedFolders([asked], { platform: "win32", homeEdits: true });
    assert.equal(edits.write, true, "edits once the person confirmed them");
    await assert.rejects(validateSharedFolders([{ ...asked, system: undefined }], { platform: "win32" }), { code: "HOME_OR_ROOT" }, "not without the request");
    await assert.rejects(validateSharedFolders([asked], { platform: "linux" }), { code: "HOME_OR_ROOT" }, "elsewhere / stays refused");
    await assert.rejects(validateSharedFolders([{ ...asked, path: base }], { platform: "win32" }), { code: "HOME_OR_ROOT" }, "folders above home stay refused");
    const [homeEdits] = await validateSharedFolders([{ id, path: home, write: true, home: true }], { homeEdits: true });
    assert.equal(homeEdits.write, true, "the home folder keeps confirmed edits too");
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(base, { recursive: true, force: true });
  }
});
