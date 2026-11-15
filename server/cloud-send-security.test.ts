import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  openCalls: [] as Array<{ path: string; flags: unknown }>,
  spoofInode: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      hooks.openCalls.push({ path: String(args[0]), flags: args[1] });
      const handle = await original.open(...args);
      if (hooks.spoofInode) {
        const origStat = handle.stat.bind(handle);
        handle.stat = (async (...opt: Parameters<typeof origStat>) => {
          const s = await origStat(...opt);
          return Object.assign(s, { ino: Number(s.ino) + 99999 });
        }) as typeof handle.stat;
      }
      return handle;
    },
  };
});

const { listBotFiles, moveFilesRoute } = await import("./cloud-send-files.ts");

describe("cloud-send TOCTOU and symlink safety", () => {
  const testDirs: string[] = [];
  afterEach(() => {
    hooks.openCalls.length = 0;
    hooks.spoofInode = false;
    for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("opens parts with O_NOFOLLOW and rejects when opened file inode does not match lstat inode", async () => {
    const data = mkdtempSync(join(tmpdir(), "omb-cs-sec-"));
    testDirs.push(data);
    const relPath = "workspaces/b1/file.txt";
    mkdirSync(join(data, "workspaces", "b1"), { recursive: true });
    writeFileSync(join(data, relPath), "sensitive data");

    const read = async (path: string) => {
      let status = 0;
      let body = Buffer.alloc(0);
      const url = new URL(`http://127.0.0.1/api/cloud-send/files?${new URLSearchParams({ path, offset: "0", length: "14" })}`);
      const deps = { dataDir: data, bots: () => [{ id: "b1" }], owner: () => ({ person: "p", name: "P" }) };
      await moveFilesRoute(deps, {
        path: "/api/cloud-send/files",
        method: "GET",
        url,
        auth: {} as never,
        req: {} as never,
        res: { setHeader() {}, writeHead: (code: number) => { status = code; }, end: ((b: any) => { body = Buffer.from(b); }) as never } as never,
        json: ((_res: unknown, code: number) => { status = code; }) as never,
        readBody: (async () => null) as never,
      });
      return { status, body: body.toString() };
    };

    // First: verify open uses numeric flags with O_NOFOLLOW
    const res1 = await read(relPath);
    expect(res1.status).toBe(200);
    expect(hooks.openCalls.length).toBeGreaterThan(0);
    const lastCall = hooks.openCalls[hooks.openCalls.length - 1]!;
    expect(typeof lastCall.flags).toBe("number");
    const noFollow = constants.O_NOFOLLOW ?? 0;
    if (noFollow !== 0) {
      expect((lastCall.flags as number) & noFollow).toBe(noFollow);
    }

    // Second: verify that if a symlink-swap race changes inode between lstat and open, read is refused with 404
    hooks.spoofInode = true;
    const res2 = await read(relPath);
    expect(res2.status).toBe(404);
  });

  it("listBotFiles verifies descriptor inode and refuses files swapped during listing", async () => {
    const data = mkdtempSync(join(tmpdir(), "omb-cs-sec-"));
    testDirs.push(data);
    const relPath = "workspaces/b1/file.txt";
    mkdirSync(join(data, "workspaces", "b1"), { recursive: true });
    writeFileSync(join(data, relPath), "data to hash");

    // With spoofed inode (simulating swapped file/symlink), file must be rejected
    hooks.spoofInode = true;
    const files = await listBotFiles(data, ["b1"]);
    expect(files).toEqual([]);
  });
});
