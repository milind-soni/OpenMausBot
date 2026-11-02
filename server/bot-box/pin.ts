import { closeSync, constants, fstatSync, openSync, readlinkSync } from "node:fs";

import type { Mount } from "./plan.ts";

// Linux O_PATH can pin sockets and files without opening their contents; Node does not export this flag.
const O_PATH = 0o10000000;

export function closeMountFds(fds: number[]): void {
  for (const fd of new Set(fds.splice(0))) try { closeSync(fd); } catch {}
}

export function pinnedBindArgs(mount: Extract<Mount, { source: string }>, fds: number[], sources: Map<string, number>): string[] {
  const flag = mount.kind === "ro" ? "--ro-bind-fd" : "--bind-fd";
  const pinned = sources.get(mount.source);
  const childFd = 3 + fds.length;
  // bubblewrap 0.11 consumes each fd-bind descriptor; spawn duplicates a shared source into a slot per mount.
  if (pinned !== undefined) {
    fds.push(pinned);
    return [flag, String(childFd), mount.target];
  }
  let fd: number;
  try { fd = openSync(mount.source, O_PATH | constants.O_NOFOLLOW); } catch (error) {
    if (mount.optional && ["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
  try {
    if (fstatSync(fd).isSymbolicLink() || readlinkSync(`/proc/self/fd/${fd}`) !== mount.source) {
      throw new Error(`The bot box mount source changed: ${mount.source}`);
    }
    fds.push(fd);
    sources.set(mount.source, fd);
    return [flag, String(childFd), mount.target];
  } catch (error) { closeSync(fd); throw error; }
}
