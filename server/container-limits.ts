/** Firefox alone runs about 430 threads with seven tabs open (Debian 12, Oct 2026): under a 512 cap its next tab, and
 * every `docker exec` into the desktop, fail to fork. The cap still stops a fork bomb. */
export const PIDS_LIMIT = 4096;
/** The cap desktops were made with before. Any other value is someone's choice and stays. */
const PREVIOUS_PIDS_LIMIT = 512;

export interface DesktopResources {
  memoryGb: number;
  cpus: number;
  /** Logical CPU ids the desktop may run on, in `docker --cpuset-cpus` form ("0,2", "4-7"); unset lets the host choose. */
  cpuset?: string;
}

const CPUSET = /^\d{1,4}(-\d{1,4})?(,\d{1,4}(-\d{1,4})?)*$/;

/** How many distinct CPUs a valid `cpuset` names: "0,2" is 2, "4-7" is 4, "0-3,2-5" is 6. */
export function cpusetSize(value: string): number {
  const ids = new Set<number>();
  for (const part of value.split(",")) {
    const [from, to = from] = part.split("-").map(Number);
    for (let id = from!; id <= to!; id++) ids.add(id);
  }
  return ids.size;
}

export function isValidCpuset(value: unknown): value is string {
  if (typeof value !== "string" || !CPUSET.test(value)) return false;
  return value.split(",").every((part) => {
    const [from, to = from] = part.split("-").map(Number);
    return from! <= to!;
  });
}

export const DEFAULT_DESKTOP_RESOURCES: DesktopResources = { memoryGb: 4, cpus: 2 };
export const MIN_DESKTOP_MEMORY_GB = 2;
export const MAX_DESKTOP_MEMORY_GB = 128;
export const MIN_DESKTOP_CPUS = 1;
export const MAX_DESKTOP_CPUS = 64;

/** Memory and swap share one limit, so a desktop gets no swap: past its budget the kernel kills processes in it rather than
 * letting it thrash the host. */
export function resourceArgs(resources: DesktopResources, options: { swap: boolean }): string[] {
  const memory = `${resources.memoryGb}g`;
  return ["--memory", memory, ...(options.swap ? ["--memory-swap", memory] : []), "--cpus", String(resources.cpus), ...(resources.cpuset ? ["--cpuset-cpus", resources.cpuset] : [])];
}

const raised = new Set<string>();

/** Docker and Podman change an existing container's cap in place, running or stopped, so a desktop made under the old cap
 * needs no recreate. Tried once per container per run: an engine without `update --pids-limit` keeps the old cap. */
export function raisePidsLimit(
  container: string,
  current: number | null | undefined,
  docker: (args: string[], timeoutMs?: number) => Promise<unknown>,
): void {
  if (current !== PREVIOUS_PIDS_LIMIT || raised.has(container)) return;
  raised.add(container);
  void Promise.resolve().then(() => docker(["update", "--pids-limit", String(PIDS_LIMIT), container], 15_000)).catch(() => {});
}

/** A stopped desktop takes the configured limits before it starts. An engine without `update --memory` keeps the old ones,
 * so a failed update is returned for the caller to report, never thrown: the desktop still starts. */
export async function applyResourcesBeforeStart(
  container: string,
  resources: DesktopResources,
  docker: (args: string[], timeoutMs?: number) => Promise<unknown>,
): Promise<string | null> {
  return docker(["update", ...resourceArgs(resources, { swap: true }), container], 15_000).then(
    () => null,
    (error: unknown) => `The desktop started with its previous limits: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** Starts a stopped desktop after applying the limits; returns the warning when they could not be applied. */
export async function startWithResources(
  container: string,
  resources: DesktopResources,
  docker: (args: string[], timeoutMs?: number) => Promise<unknown>,
): Promise<string | null> {
  const warning = await applyResourcesBeforeStart(container, resources, docker);
  await docker(["start", container]);
  return warning;
}
