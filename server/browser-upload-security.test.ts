import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  beforeRead: null as ((input: number) => void) | null,
  afterOpen: null as ((path: fs.PathLike) => void) | null,
  openFlags: null as ((path: fs.PathLike, flags: fs.OpenMode) => fs.OpenMode) | null,
  readlink: null as ((path: fs.PathLike) => string) | null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    openSync: (...args: Parameters<typeof original.openSync>) => {
      const input = original.openSync(args[0], hooks.openFlags?.(args[0], args[1]) ?? args[1], args[2]);
      hooks.afterOpen?.(args[0]);
      return input;
    },
    readlinkSync: (...args: Parameters<typeof original.readlinkSync>) => hooks.readlink?.(args[0]) ?? original.readlinkSync(...args),
    readSync: (...args: Parameters<typeof original.readSync>) => {
      hooks.beforeRead?.(args[0]);
      return original.readSync(...args);
    },
    read: Object.defineProperties((...args: Parameters<typeof original.read>) => {
      hooks.beforeRead?.(args[0]);
      return original.read(...args);
    }, Object.getOwnPropertyDescriptors(original.read)),
  };
});

const { namedUploadPaths, uploadableFiles } = await import("./browser-upload.ts");
const dirs: string[] = [];
afterEach(() => {
  hooks.beforeRead = null;
  hooks.afterOpen = null;
  hooks.openFlags = null;
  hooks.readlink = null;
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it.each(["darwin", "linux"])("stages a regular file with valid %s open flags", async (platform) => {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "omb-upload-flags-")));
  dirs.push(base);
  const source = join(base, "report.txt");
  fs.writeFileSync(source, "report");
  vi.stubGlobal("process", { ...process, platform });
  const flags: fs.OpenMode[] = [];
  if (platform === "linux") hooks.readlink = () => source;
  hooks.openFlags = (path, mode) => {
    if (path !== source) return mode;
    flags.push(mode);
    if (platform === "darwin" && typeof mode === "number") {
      if ((mode & 0x20000000) && (mode & fs.constants.O_NOFOLLOW)) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
      return (mode & ~0x20000000) | fs.constants.O_NOFOLLOW;
    }
    return mode;
  };
  const [staged] = await namedUploadPaths([{ file: source, name: "Report.txt" }], join(base, "uploads"));
  expect(flags).toEqual([platform === "darwin" ? fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | 0x20000000
    : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW]);
  expect(fs.readFileSync(staged!, "utf8")).toBe("report");
});

it.each([false, true])("stages workspace files on Windows from the checked path (everyFile: %s)", async (everyFile) => {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "omb-upload-windows-")));
  dirs.push(base);
  const source = join(base, "report.txt"), folder = join(base, "uploads");
  fs.writeFileSync(source, "report");
  vi.stubGlobal("process", { ...process, platform: "win32" });
  const flags: fs.OpenMode[] = [];
  hooks.openFlags = (path, mode) => {
    if (path === source) flags.push(mode);
    return mode;
  };
  const [staged] = await namedUploadPaths([{ file: source, name: everyFile ? null : "Report.txt" }], folder, Date.now(), { everyFile });
  expect(flags).toEqual([fs.constants.O_RDONLY]);
  expect(staged).not.toBe(source);
  expect(fs.readFileSync(staged!, "utf8")).toBe("report");
});

it.skipIf(process.platform === "win32")("pins both sources before a directory is swapped while the first file copies", async () => {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "omb-upload-race-")));
  dirs.push(base);
  const workspace = join(base, "workspace"), sub = join(workspace, "sub"), outside = join(base, "outside");
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(join(workspace, "large.bin"), Buffer.alloc(1024 * 1024 + 1));
  fs.writeFileSync(join(sub, "report.txt"), "report");
  fs.writeFileSync(join(outside, "report.txt"), "outside secret");
  const checked = uploadableFiles([join(workspace, "large.bin"), join(sub, "report.txt")], [workspace]);
  if ("error" in checked) throw new Error(checked.error);
  hooks.beforeRead = () => {
    hooks.beforeRead = null;
    fs.rmSync(sub, { recursive: true });
    fs.symlinkSync(outside, sub, "dir");
  };
  const staged = await namedUploadPaths(checked.files.map((file) => ({ file, name: null })), join(base, "uploads"), Date.now(), { everyFile: true });
  expect(fs.readFileSync(staged[1]!, "utf8")).toBe("report");
});

it.skipIf(process.platform === "win32")("removes every directory from a batch when its second file fails", async () => {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "omb-upload-cleanup-")));
  dirs.push(base);
  const first = join(base, "first.txt"), second = join(base, "second.txt"), folder = join(base, "uploads");
  fs.writeFileSync(first, "first");
  fs.writeFileSync(second, "second");
  const secondInode = fs.statSync(second, { bigint: true }).ino;
  hooks.beforeRead = (input) => {
    if (fs.fstatSync(input, { bigint: true }).ino === secondInode) fs.truncateSync(second, 0);
  };
  await expect(async () => namedUploadPaths([
    { file: first, name: "First.txt" }, { file: second, name: "Second.txt" },
  ], folder)).rejects.toThrow(/changed/);
  expect(fs.readdirSync(folder)).toEqual([]);
});

it.skipIf(process.platform === "win32")("rejects an oversized sparse file before reading it", async () => {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "omb-upload-size-")));
  dirs.push(base);
  const source = join(base, "large.bin");
  fs.writeFileSync(source, "");
  fs.truncateSync(source, 25 * 1024 * 1024 + 1);
  let read = false;
  hooks.beforeRead = () => { read = true; };
  await expect(async () => namedUploadPaths([{ file: source, name: "Large.bin" }], join(base, "uploads"))).rejects.toThrow(/limit/i);
  expect(read).toBe(false);
});

it.skipIf(process.platform === "win32")("rejects a batch over 100 MiB before reading any file", async () => {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "omb-upload-batch-")));
  dirs.push(base);
  const files = Array.from({ length: 5 }, (_, i) => {
    const file = join(base, `${i}.bin`);
    fs.writeFileSync(file, "");
    fs.truncateSync(file, 21 * 1024 * 1024);
    return { file, name: `Upload-${i}.bin` };
  });
  let read = false;
  hooks.beforeRead = () => { read = true; };
  await expect(async () => namedUploadPaths(files, join(base, "uploads"))).rejects.toThrow(/limit/i);
  expect(read).toBe(false);
});

it.skipIf(process.platform === "win32")("lets the event loop run while an accepted upload copies", async () => {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "omb-upload-async-")));
  dirs.push(base);
  const source = join(base, "large.bin");
  fs.writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 0x61));
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const [staged] = await namedUploadPaths([{ file: source, name: "Large.bin" }], join(base, "uploads"));
  expect(yielded).toBe(true);
  expect(fs.readFileSync(staged!)).toEqual(Buffer.alloc(2 * 1024 * 1024, 0x61));
});

it.skipIf(process.platform === "win32")("rejects a directory symlink inserted after the allowlist check before staging", async () => {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "omb-upload-parent-")));
  dirs.push(base);
  const workspace = join(base, "workspace"), sub = join(workspace, "sub"), outside = join(base, "outside");
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(join(sub, "report.txt"), "report");
  fs.writeFileSync(join(outside, "report.txt"), "outside secret");
  const checked = uploadableFiles([join(sub, "report.txt")], [workspace]);
  if ("error" in checked) throw new Error(checked.error);
  fs.rmSync(sub, { recursive: true });
  fs.symlinkSync(outside, sub, "dir");
  await expect(async () => namedUploadPaths(checked.files.map((file) => ({ file, name: "Report.txt" })), join(base, "uploads"))).rejects.toThrow();
});
