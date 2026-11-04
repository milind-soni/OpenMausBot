import { freemem, totalmem } from "node:os";

const MB = 1024 * 1024;

export interface BoxMemory {
  /** What this server may use: its cgroup's limit when one is set below the machine's memory, else the machine's. */
  bytes: number;
  /** Set only when a cgroup (a container's --memory, a systemd MemoryMax) caps this server below the machine's memory. */
  cgroupLimit: number | null;
}

/** libuv reads cgroup v2 `memory.max` or v1 `memory.limit_in_bytes` along /proc/self/cgroup and reports the tightest;
 * with no limit it answers 0, or UINT64_MAX for a cgroup whose limit is "max". */
export function boxMemoryFrom(constrained: number, total: number): BoxMemory {
  const cgroupLimit = constrained > 0 && constrained < total ? constrained : null;
  return { bytes: cgroupLimit ?? total, cgroupLimit };
}

let box: BoxMemory | undefined;
export function boxMemory(): BoxMemory {
  box ??= boxMemoryFrom(process.constrainedMemory?.() ?? 0, totalmem());
  return box;
}

/** Free memory within the cgroup limit where there is one. */
export function availableMemory(): number {
  return process.availableMemory?.() ?? freemem();
}

const HEAP_SHARE = 0.6;
const HEAP_MIN_MB = 128, HEAP_MAX_MB = 4096;
/** Desktop / unconstrained hosts: floor so large typecheck-class graphs and long threads do not OOM at defaults. */
const DESKTOP_HEAP_MB = 8192;

/** Node sizes its old space to a quarter of a cgroup limit; a server on a small box runs out of heap long before the box
 * runs out of memory. When NODE_OPTIONS already sizes the heap, leave it alone. Without a cgroup limit, apply a desktop floor. */
export function heapSizeArgs(cgroupLimit: number | null, nodeOptions: string | undefined): string[] {
  if (/--max[-_]old[-_]space[-_]size/.test(nodeOptions ?? "")) return [];
  if (cgroupLimit === null) return [`--max-old-space-size=${DESKTOP_HEAP_MB}`];
  const mb = Math.min(HEAP_MAX_MB, Math.max(HEAP_MIN_MB, Math.floor((cgroupLimit * HEAP_SHARE) / MB)));
  return [`--max-old-space-size=${mb}`];
}
