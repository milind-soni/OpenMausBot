import { existsSync } from "node:fs";

/** Debian's tini package, which the server image installs and names as its entrypoint. */
export const IMAGE_INIT = "/usr/bin/tini";
const DOCS = 'docs/self-hosting.md, "Running on a container platform"';

export interface ContainerInit {
  /** What the server's command line starts with; empty when something else already collects exited processes. */
  prefix: string[];
  /** Said once at start, when this process found itself the container's process 1. */
  line: string | null;
}

/** Linux hands a process whose parent exited to process 1 (or the nearest subreaper), which must wait() for it or it
 * stays in the process table as a zombie and counts against the container's pids limit. Node waits only for the
 * children it started itself, so as process 1 it needs an init between it and the bots' processes. */
export function containerInit(options: { pid?: number; platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {}): ContainerInit {
  if ((options.platform ?? process.platform) !== "linux" || (options.pid ?? process.pid) !== 1) return { prefix: [], line: null };
  if ((options.exists ?? existsSync)(IMAGE_INIT)) {
    return {
      // -s: tini is not process 1 here, so it asks the kernel to hand it its descendants' orphans.
      prefix: [IMAGE_INIT, "-s", "--"],
      line: `OpenMausBot is process 1 in this container: the image's entrypoint was replaced. The server runs under ${IMAGE_INIT} instead, so the processes bots leave behind are still collected (${DOCS}).`,
    };
  }
  return {
    prefix: [],
    line: `OpenMausBot is process 1 in this container and no init is installed: nothing collects the processes bots leave behind, so they pile up until the container's process limit and bots fail to start ("spawn EAGAIN"). Start the container with an init (docker run --init, or tini as its entrypoint): ${DOCS}.`,
  };
}
