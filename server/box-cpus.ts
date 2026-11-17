import { availableParallelism } from "node:os";

/** CPUs this server may use. Node 24 (libuv 1.52) counts a cgroup's `cpu.max` quota and the affinity mask here, so a
 * container's --cpus limit is honoured; `os.cpus()` reports the host's. A fractional quota rounds down, never below 1. */
export function boxCpus(): number {
  return Math.max(1, availableParallelism());
}
