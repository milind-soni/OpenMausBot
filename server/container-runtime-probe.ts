import type { CommandRunner, Runtime } from "./container-computer.ts";

// A runtime whose info check timed out (a wedged Docker Desktop answers `docker info` only at the timeout) counts as
// down for HUNG_PROBE_MS without a new process, so a recovered one is seen up to that late. Fast errors and healthy
// checks are never remembered; concurrent callers share one check.
const HUNG_PROBE_MS = 30_000;
type RuntimeProbe = { hungUntil: number; inflight: Promise<boolean> | null };
const runtimeProbes = new WeakMap<CommandRunner, Map<Runtime, RuntimeProbe>>();

export function runtimeHealthy(runner: CommandRunner, runtime: Runtime): Promise<boolean> {
  let probes = runtimeProbes.get(runner);
  if (!probes) runtimeProbes.set(runner, (probes = new Map()));
  let probe = probes.get(runtime);
  if (!probe) probes.set(runtime, (probe = { hungUntil: 0, inflight: null }));
  if (Date.now() < probe.hungUntil) return Promise.resolve(false);
  if (probe.inflight) return probe.inflight;
  const state = probe;
  const infoArgs = runtime === "container"
    ? ["system", "status"]
    : runtime === "podman"
      ? ["info", "--format", "json"]
      : ["info", "--format", "{{.ServerVersion}}"];
  const check = (async () => {
    try {
      await runner(runtime, infoArgs, 10_000);
      return true;
    } catch (error) {
      const failure = error as { killed?: boolean; code?: unknown } | null;
      if (failure?.killed === true || failure?.code === "ETIMEDOUT") state.hungUntil = Date.now() + HUNG_PROBE_MS;
      return false;
    }
  })();
  state.inflight = check;
  void check.finally(() => {
    if (state.inflight === check) state.inflight = null;
  });
  return check;
}
