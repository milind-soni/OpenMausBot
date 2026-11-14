import { createHash } from "node:crypto";

const HOUR = 3600_000;
export const TRIAL_ENDING_SOON_MS = 48 * HOUR;
/** Most cards settle at once; Indian cards and UPI take about two days. */
export const PROCESSING_NOTICE_AFTER_MS = HOUR;

export function trialNoticeState(trial, now) {
  if (!trial || !Number.isSafeInteger(trial.endsAt)) return null;
  if (trial.state === "active") return trial.endsAt - now <= TRIAL_ENDING_SOON_MS ? "active" : null;
  if (trial.state === "processing") return now - trial.endsAt >= PROCESSING_NOTICE_AFTER_MS ? "processing" : null;
  return ["ending", "late", "ended"].includes(trial.state) ? trial.state : null;
}

export function localDay(now) {
  const date = new Date(now), two = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** Hashed, so no account id is on disk. */
export function createTrialNotices({ read, write, now = Date.now }) {
  let shown = null;
  const today = () => {
    const day = localDay(now());
    if (shown?.day === day) return shown;
    let saved = null;
    try { saved = read(); } catch {}
    const keys = saved?.day === day && Array.isArray(saved.shown) ? saved.shown.filter(key => typeof key === "string" && /^[a-f0-9]{32}$/.test(key)) : [];
    shown = { day, keys: keys.slice(-50) };
    return shown;
  };
  const current = state => {
    if (state?.status !== "connected" || typeof state.account?.id !== "string" || !state.trial) return null;
    const notice = trialNoticeState(state.trial, now());
    if (!notice) return null;
    return { notice, key: createHash("sha256").update(`${state.account.id}\n${state.trial.endsAt}\n${notice}`).digest("hex").slice(0, 32) };
  };
  return {
    due(state) {
      const found = current(state);
      return found && !today().keys.includes(found.key) ? found.notice : null;
    },
    seen(state) {
      const found = current(state), record = today();
      if (!found || record.keys.includes(found.key)) return;
      record.keys = [...record.keys, found.key].slice(-50);
      try { write({ day: record.day, shown: record.keys }); } catch {}
    },
  };
}
