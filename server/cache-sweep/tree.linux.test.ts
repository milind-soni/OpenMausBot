// The open-folder walk (tree.ts) with a swap placed exactly between its look at a name and its act on it, with no timing:
// node:fs/promises' lstat is wrapped so a test can change the disk right after the walk has looked. Linux only, as the
// walk is. Every path lives under each test's own temporary folder.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const after: { lstat: ((path: string) => void) | null } = { lstat: null };
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (async (path: string, ...rest: unknown[]) => {
      const stat = await (actual.lstat as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
      after.lstat?.(String(path));
      return stat;
    }) as typeof actual.lstat,
  };
});

const { Pacer, close, openFolder, removeChild } = await import("./tree.ts");

const dirs: string[] = [];
afterEach(() => { after.lstat = null; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function scene() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "omb-cache-tree-")));
  dirs.push(base);
  const root = join(base, "cache"), precious = join(base, "precious");
  mkdirSync(join(root, "uv", "d1"), { recursive: true });
  for (const name of ["f1", "f2"]) writeFileSync(join(root, "uv", "d1", name), "cache");
  writeFileSync(join(root, "uv", "f0"), "cache");
  mkdirSync(precious);
  for (let i = 0; i < 5; i++) writeFileSync(join(precious, `p${i}`), "precious");
  writeFileSync(join(precious, "f1"), "precious");
  return { base, root, precious };
}

async function removeUv(root: string) {
  const folder = await openFolder(root);
  if (!folder) throw new Error("root not opened");
  try { return await removeChild(folder, "uv", new Pacer()); } finally { await close(folder); }
}

describe.skipIf(process.platform !== "linux")("a swap between the walk's look and its act", () => {
  it("the unit swapped for a link just before it is renamed: only the link is renamed and removed", async () => {
    const { root, precious } = scene();
    after.lstat = (path) => {
      if (!path.endsWith("/uv")) return;
      after.lstat = null;
      renameSync(path, `${path}-real`);
      symlinkSync(precious, path);
    };
    expect(await removeUv(root)).toMatchObject({ partial: true });
    expect(readdirSync(root).sort()).toEqual(["uv-real"]);
    expect(readdirSync(precious)).toHaveLength(6);
  });

  it("a folder swapped for a link after it was looked at is not entered: the folder the link names keeps everything", async () => {
    const { root, precious } = scene();
    after.lstat = (path) => {
      if (!path.endsWith("/d1")) return;
      after.lstat = null;
      renameSync(path, `${path}.real`);
      symlinkSync(precious, path);
    };
    expect(await removeUv(root)).toMatchObject({ partial: true });
    expect(readdirSync(precious).sort()).toEqual(["f1", "p0", "p1", "p2", "p3", "p4"]);
  });

  it("a file swapped for a link after it was looked at: the link is removed, never what it names", async () => {
    const { root, precious } = scene();
    after.lstat = (path) => {
      if (!path.endsWith("/f1")) return;
      after.lstat = null;
      unlinkSync(path);
      symlinkSync(join(precious, "f1"), path);
    };
    expect(await removeUv(root)).toMatchObject({ partial: false });
    expect(existsSync(join(root, "uv"))).toBe(false);
    expect(readdirSync(precious)).toHaveLength(6);
  });

  it("the folder being emptied, swapped for a link mid-walk: the walk stays in the folder it opened", async () => {
    const { root, precious } = scene();
    after.lstat = (path) => {
      if (!path.endsWith("/f0")) return;
      after.lstat = null;
      // It was renamed on its way out: the swap names that.
      const trash = readdirSync(root).find((name) => name.startsWith(".omb-trash-"))!;
      renameSync(join(root, trash), join(root, "uv-moved"));
      symlinkSync(precious, join(root, trash));
    };
    expect(await removeUv(root)).toMatchObject({ partial: true });
    expect(readdirSync(join(root, "uv-moved"))).toEqual([]);
    expect(readdirSync(precious)).toHaveLength(6);
  });
});
