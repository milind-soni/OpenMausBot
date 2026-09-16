/** Private child progress extends only restoration, never ordinary startup. */
export function createRestoreStartupProgress(now = Date.now) {
  let state;
  let sequence = 0;
  return {
    get: () => state,
    receive(message) {
      if (message?.type !== "workspace-restore-progress" ||
          !["checking", "copying", "applying", "done"].includes(message.phase) ||
          !Number.isSafeInteger(message.sequence) || message.sequence <= sequence ||
          !Number.isSafeInteger(message.bytes) || message.bytes < 0 || state?.phase === "done") return false;
      sequence = message.sequence;
      state = { phase: message.phase, bytes: message.bytes, at: now() };
      return true;
    },
  };
}
