// On a Mac, Podman runs containers inside its own small VM (a "Podman machine"), which stays stopped after the Mac
// restarts. A bot that needs the Local VM starts that machine itself instead of failing with "Start podman first".
import { sh, type CommandRunner, type ContainerComputerStatus } from "./container-computer.ts";

const MACHINE_START_TIMEOUT_MS = 3 * 60_000;
/** After a failed start, turns get the same message for a while instead of each waiting on another failing start. */
const FAILED_START_BACKOFF_MS = 5 * 60_000;
const RECHECK_TRIES = 5;

type MachineEntry = { Name?: unknown; Default?: unknown; Running?: unknown; Starting?: unknown };
type RuntimeStatus = Pick<ContainerComputerStatus, "runtime" | "daemonUp" | "problem">;

let starting: Promise<boolean> | null = null;
let lastFailure: { at: number; problem: string } | null = null;

type Seams = { runner?: CommandRunner; platform?: NodeJS.Platform; now?: () => number; pause?: (ms: number) => Promise<void> };
const pauseFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Mac only: when Podman is the runtime and does not answer because its machine is set up but stopped, starts that
 * machine (calling `onStart` first, so the person sees it starting) and returns `recheck()`'s fresh status. Otherwise
 * returns `status` unchanged: not a Mac, Podman is not the runtime, it already answers, no machine was ever set up
 * (this never creates or installs one), or one is already running or starting. When the start fails, returns
 * `status` with a problem the person can act on.
 */
export async function startStoppedPodmanMachine<S extends RuntimeStatus>(
  status: S,
  recheck: () => Promise<S>,
  onStart: () => void = () => {},
  { runner = sh, platform = process.platform, now = Date.now, pause = pauseFor }: Seams = {},
): Promise<S> {
  if (platform !== "darwin" || status.runtime !== "podman" || status.daemonUp) return status;
  if (lastFailure && now() - lastFailure.at < FAILED_START_BACKOFF_MS) return { ...status, problem: lastFailure.problem };
  // Turns that arrive together share one start.
  starting ??= startMachine(runner, onStart).finally(() => { starting = null; });
  try {
    if (!(await starting)) return status;
  } catch (error) {
    lastFailure = { at: now(), problem: (error as Error).message };
    return { ...status, problem: lastFailure.problem };
  }
  // Podman's API socket can answer a moment after `machine start` returns.
  let fresh = await recheck();
  for (let tries = 1; tries < RECHECK_TRIES && !fresh.daemonUp; tries++) {
    await pause(1_000);
    fresh = await recheck();
  }
  return fresh;
}

async function startMachine(runner: CommandRunner, onStart: () => void): Promise<boolean> {
  let machines: MachineEntry[];
  try {
    const parsed: unknown = JSON.parse((await runner("podman", ["machine", "list", "--format", "json"], 10_000)).stdout);
    machines = Array.isArray(parsed) ? parsed : [];
  } catch {
    return false;
  }
  if (machines.some((machine) => machine.Running === true || machine.Starting === true)) return false;
  const machine = machines.find((entry) => entry.Default === true) ?? (machines.length === 1 ? machines[0] : undefined);
  if (typeof machine?.Name !== "string" || !machine.Name) return false;
  onStart();
  try {
    await runner("podman", ["machine", "start", machine.Name], MACHINE_START_TIMEOUT_MS);
  } catch (error) {
    // execFile's message starts with the whole command line; Podman's own last stderr line says what went wrong.
    const detail = String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n").at(-1)?.trim();
    throw new Error(`The Podman machine "${machine.Name}" did not start${detail ? ` (${detail})` : ""}; run podman machine start`, { cause: error });
  }
  lastFailure = null;
  return true;
}
