import fs from "node:fs";
import path from "node:path";

export const ROUTINE_WAKE_POLL_MS = 60_000;

/** Keeps the system from idle-sleeping while letting the display turn off. */
export const ROUTINE_WAKE_BLOCKER = "prevent-app-suspension";

export function routineWakeDecision({ enabled, onBattery, status }) {
  if (!enabled) return { hold: false, reason: "off", at: null };
  if (onBattery) return { hold: false, reason: "battery", at: null };
  if (!status || status.hold !== true) return { hold: false, reason: "idle", at: null };
  return { hold: true, reason: status.reason === "running" ? "running" : "due", at: typeof status.at === "number" ? status.at : null };
}

const settingsFile = (userData) => path.join(userData, "routine-wake.json");

export function routineWakeSettings(userData) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(userData), "utf8"));
    return { keepAwake: parsed?.keepAwake !== false };
  } catch {
    return { keepAwake: true };
  }
}

export function rememberRoutineWake(userData, keepAwake) {
  const file = settingsFile(userData);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ keepAwake: keepAwake !== false }, null, 2));
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
    }
  }
}

/**
 * `deps`:
 * - fetchStatus(): Promise<{hold, reason?, at?} | null> — the server's answer, null when unreachable
 * - isOnBattery(): boolean
 * - blocker: { start(type): id, stop(id), isStarted(id): boolean } — Electron's powerSaveBlocker
 * - settings(): { keepAwake: boolean }
 * - log(line)
 */
export function createRoutineWakeHold(deps) {
  let blockerId = null;
  let timer = null;
  let last = { hold: false, reason: "idle", at: null };

  const apply = (decision) => {
    if (decision.hold && blockerId === null) {
      blockerId = deps.blocker.start(ROUTINE_WAKE_BLOCKER);
      deps.log?.(`routine wake: holding this computer awake (${decision.reason}${decision.at ? ` at ${new Date(decision.at).toISOString()}` : ""})`);
    } else if (!decision.hold && blockerId !== null) {
      if (deps.blocker.isStarted(blockerId)) deps.blocker.stop(blockerId);
      blockerId = null;
      deps.log?.(`routine wake: released (${decision.reason})`);
    }
    last = decision;
  };

  const poll = async () => {
    const status = await Promise.resolve()
      .then(() => deps.fetchStatus())
      .catch(() => null);
    apply(routineWakeDecision({ enabled: deps.settings().keepAwake, onBattery: deps.isOnBattery(), status }));
    return state();
  };

  const state = () => ({ ...last, keepAwake: deps.settings().keepAwake, onBattery: deps.isOnBattery() });

  return {
    start() {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), deps.pollMs ?? ROUTINE_WAKE_POLL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      apply({ hold: false, reason: "stopped", at: null });
    },
    poll,
    state,
    holding: () => blockerId !== null,
  };
}
