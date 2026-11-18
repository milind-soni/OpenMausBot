import { describe, expect, it } from "vitest";
import { chromeArgs } from "./flags.ts";
import { devShmIsSmall } from "./shm.ts";

const MB = 1024 * 1024;
const shm = (bytes: number) => () => ({ blocks: bytes / 4096, bsize: 4096 });

describe("a small /dev/shm", () => {
  it("is one under the 512 MB the compose files give, or one that is missing; only Linux has it", () => {
    expect(devShmIsSmall("linux", shm(64 * MB))).toBe(true);
    expect(devShmIsSmall("linux", shm(511 * MB))).toBe(true);
    expect(devShmIsSmall("linux", shm(512 * MB))).toBe(false);
    expect(devShmIsSmall("linux", () => ({ blocks: 2_000_000n, bsize: 4096n }))).toBe(false);
    expect(devShmIsSmall("linux", () => { throw Object.assign(new Error("no such file"), { code: "ENOENT" }); })).toBe(true);
    for (const platform of ["darwin", "win32"] as const) {
      expect(devShmIsSmall(platform, () => { throw new Error("never read"); })).toBe(false);
    }
  });

  it("keeps Chrome's shared memory out of it on any host, not only where Docker left its mark", () => {
    const args = (host: "server" | "desktop", smallShm: boolean) => chromeArgs({ userDataDir: "/p", mode: "headless", host, platform: "linux", smallShm });
    expect(args("server", true)).toContain("--disable-dev-shm-usage");
    expect(args("desktop", true)).toContain("--disable-dev-shm-usage");
    expect(args("server", false)).not.toContain("--disable-dev-shm-usage");
    expect(chromeArgs({ userDataDir: "/p", mode: "headless", host: "container", platform: "linux", smallShm: false })).toContain("--disable-dev-shm-usage");
  });
});
