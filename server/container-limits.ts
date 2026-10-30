/** Firefox alone runs about 430 threads with seven tabs open (Debian 12, Oct 2026): under a 512 cap its next tab, and
 * every `docker exec` into the desktop, fail to fork. The cap still stops a fork bomb. */
export const PIDS_LIMIT = 4096;
/** The cap desktops were made with before. Any other value is someone's choice and stays. */
const PREVIOUS_PIDS_LIMIT = 512;

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
