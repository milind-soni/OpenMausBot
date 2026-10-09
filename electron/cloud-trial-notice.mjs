// The free trial's popup (docs/cloud-pro.md, "Free trial"): which notice the
// Cloud session's `trial` makes due, and the record that shows each one at
// most once a day. Main answers this computer's page and the person's own
// Cloud's alike (cloud-plan:state), so a notice seen on one is not shown
// again on the other. What a notice says is the renderer's (lib/cloud-plan).
import { createHash } from "node:crypto";

const HOUR = 3600_000;
/** An active trial says so only in its last two days. */
export const TRIAL_ENDING_SOON_MS = 48 * HOUR;
/** A first payment still processing says so only after an hour: most cards
 * settle at once, and Indian cards and UPI about two days later. */
export const PROCESSING_NOTICE_AFTER_MS = HOUR;

/** The notice this trial makes due now, or null: an active trial only in its
 * last two days, a processing payment only after an hour, and ending, late
 * or ended whenever the Admin says so. A state this app does not know shows
 * nothing. */
export function trialNoticeState(trial, now) {
  if (!trial || !Number.isSafeInteger(trial.endsAt)) return null;
  if (trial.state === "active") return trial.endsAt - now <= TRIAL_ENDING_SOON_MS ? "active" : null;
  if (trial.state === "processing") return now - trial.endsAt >= PROCESSING_NOTICE_AFTER_MS ? "processing" : null;
  return ["ending", "late", "ended"].includes(trial.state) ? trial.state : null;
}

/** This computer's calendar day, which "once a day" counts in. */
export function localDay(now) {
  const date = new Date(now), two = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** The notices shown today, by account, trial and state: a notice is due
 * when its trial makes it due and it has not been shown today. Kept with
 * `read`/`write` (a small file in main), hashed so no account id is on disk,
 * and only today's: a new day makes every notice still due show once more.
 * A failed write costs at most one more showing. */
export function createTrialNotices({ read, write, now = Date.now }) {
  let shown = null;
  const today = () => {
    const day = localDay(now());
    if (shown?.day === day) return shown;
    let saved = null;
    try { saved = read(); } catch { /* nothing shown yet */ }
    const keys = saved?.day === day && Array.isArray(saved.shown) ? saved.shown.filter(key => typeof key === "string" && /^[a-f0-9]{32}$/.test(key)) : [];
    shown = { day, keys: keys.slice(-50) };
    return shown;
  };
  /** The notice due for this verified account state, and its key. */
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
    /** The notice due now was shown: not again today. Names nothing; main knows the state. */
    seen(state) {
      const found = current(state), record = today();
      if (!found || record.keys.includes(found.key)) return;
      record.keys = [...record.keys, found.key].slice(-50);
      try { write({ day: record.day, shown: record.keys }); } catch { /* shown once more at worst */ }
    },
  };
}
