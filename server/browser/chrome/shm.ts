import { statfsSync } from "node:fs";

/** What the compose files give /dev/shm. Docker's default, and most container platforms', is 64 MB, which a Chrome page
 * with large images or a video fills; Chrome then crashes the tab (crbug.com/736452). */
const ROOMY_BYTES = 512 * 1024 * 1024;

type Statfs = (path: string) => { blocks: number | bigint; bsize: number | bigint };

/** True where Chrome should keep its shared memory out of /dev/shm (--disable-dev-shm-usage puts it in /tmp). */
export function devShmIsSmall(platform: NodeJS.Platform = process.platform, statfs: Statfs = statfsSync): boolean {
  if (platform !== "linux") return false;
  try {
    const stats = statfs("/dev/shm");
    return Number(stats.blocks) * Number(stats.bsize) < ROOMY_BYTES;
  } catch {
    return true;
  }
}
