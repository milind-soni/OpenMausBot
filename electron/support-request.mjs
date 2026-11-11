// Contact support: a paying Cloud customer's message to the MausBot team, sent from main on this device's MausBot Cloud
// sign-in to the report intake @devs reports use (openmaus-cloud server/support-request-contract.ts, POST /api/bug-reports
// with `kind: "support"`), so the Admin names the account and its plan itself. A message that can't go now (offline, a
// server error, the hourly limit) waits in a small outbox beside the sign-in and is sent again on its own, on @devs reports'
// schedule (server/host/devs-reports.ts RETRY_MS), for a week, as the same account only.

export const SUPPORT_TOPICS = ["billing", "broken", "question", "other"];
export const SUPPORT_LIMITS = { message: 5_000, replyTo: 254, diagnostics: 48_000, field: 40 };
/** Where it is sent from, as the Admin reads it: this computer's page, My Cloud's, or another Cloud's (its id). */
const PLACE = /^(?:desktop|my-cloud|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const EMAIL = /^[^\s@,;<>"()[\]\\:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const KEPT_MS = 7 * 24 * 3_600_000;
export const MAX_OUTBOX = 10;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The diagnostics checkbox's start for a topic: on for something broken, off otherwise (never for billing). */
export const diagnosticsByDefault = topic => topic === "broken";

/** An address the Admin takes, trimmed and lower-cased, or null. */
export function replyAddress(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.length <= SUPPORT_LIMITS.replyTo && EMAIL.test(email) ? email : null;
}

const oneLine = (value, max) => (typeof value === "string" ? value.replace(/\p{Cc}+/gu, " ").trim().slice(0, max) : "") || "unknown";

/**
 * The page's form as main sends it: the topic, the message, the reply-to and the diagnostics checked here, and where it came
 * from and the app's version named by main. Throws a plain sentence for anything the form should not have let through.
 */
export function supportBody(input, { place, appVersion, platform }) {
  const topic = input?.topic, message = typeof input?.message === "string" ? input.message : "";
  if (!SUPPORT_TOPICS.includes(topic)) throw new Error("Choose a topic.");
  if (!message.trim() || message.length > SUPPORT_LIMITS.message) throw new Error("Write a message of at most 5,000 characters.");
  const replyTo = replyAddress(input?.replyTo);
  if (!replyTo) throw new Error("Enter the email address to reply to.");
  const diagnostics = typeof input?.diagnostics === "string" && input.diagnostics.trim() ? input.diagnostics.slice(0, SUPPORT_LIMITS.diagnostics) : null;
  return { kind: "support", topic, message, replyTo, appVersion: oneLine(appVersion, SUPPORT_LIMITS.field), platform: oneLine(platform, SUPPORT_LIMITS.field),
    ...(PLACE.test(place) ? { place } : {}), ...(diagnostics ? { diagnostics } : {}) };
}

/**
 * What one attempt came to, from the intake's answer (`status` and its JSON body), or null when it was never reached:
 * `sent` (201 { id }), `off` (switched off: the address to write to), `unavailable` (403: no paid plan), `signin` (401), `retry`
 * (offline, a server error, the hourly limit), `refused` (400 or 413: sending it again would be refused again).
 */
export function supportOutcome(answer) {
  if (!answer) return { outcome: "retry" };
  const { status, body } = answer;
  if (status >= 200 && status < 300) {
    if (body?.accepted === false && typeof body.supportEmail === "string" && replyAddress(body.supportEmail)) return { outcome: "off", email: body.supportEmail.trim() };
    return typeof body?.id === "string" && ID.test(body.id) ? { outcome: "sent", id: body.id } : { outcome: "retry" };
  }
  if (status === 401) return { outcome: "signin" };
  if (status === 403) return { outcome: "unavailable" };
  if (status === 400 || status === 413) return { outcome: "refused", detail: typeof body?.error === "string" ? body.error.replace(/\p{Cc}+/gu, " ").slice(0, 200) : "" };
  return { outcome: "retry" };
}

/**
 * The outbox: `send(body)` makes one attempt as the account signed in now and answers { status, body } or null; `account()`
 * is that account's id (null signed out). Each message waits for its own account and goes on RETRY_MS's schedule.
 * @param {{ store: { read(): unknown; write(value: unknown): void }, send: (body: object) => Promise<{ status: number; body: unknown } | null>,
 *   account: () => string | null, now?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, log?: (line: string) => void }} options
 */
export function createSupportOutbox({ store, send, account, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
  let waiting = [];
  try {
    const saved = store.read();
    if (Array.isArray(saved?.waiting)) waiting = saved.waiting.filter(entry => entry && typeof entry.account === "string" && entry.body?.kind === "support" && Number.isFinite(entry.nextAt)).slice(-MAX_OUTBOX);
  } catch { /* none saved yet */ }
  let timer = null, running = null;
  const save = () => { try { store.write({ version: 1, waiting }); } catch (error) { log(`Support outbox could not be saved: ${error?.message ?? error}`); } };
  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (!waiting.length) return;
    const due = Math.max(1_000, Math.min(...waiting.map(entry => entry.nextAt)) - now());
    timer = setTimer(() => { timer = null; void flush(); }, due);
    timer?.unref?.();
  };
  async function attempt(entry) {
    const result = supportOutcome(await send(entry.body).catch(() => null));
    if (result.outcome === "retry" || result.outcome === "signin") {
      entry.attempts += 1;
      entry.nextAt = now() + RETRY_MS[Math.min(entry.attempts - 1, RETRY_MS.length - 1)];
      if (now() - entry.firstAt > KEPT_MS) waiting = waiting.filter(one => one !== entry);
    } else waiting = waiting.filter(one => one !== entry);
    return result;
  }
  async function flush() {
    if (running) return running;
    running = (async () => {
      const me = account();
      for (const entry of waiting.filter(one => one.nextAt <= now())) {
        if (entry.account === me) await attempt(entry);
        else entry.nextAt = now() + RETRY_MS[0];
      }
      waiting = waiting.filter(entry => now() - entry.firstAt <= KEPT_MS);
      save();
    })().finally(() => { running = null; schedule(); });
    return running;
  }
  schedule();
  return {
    /** One message from the person: sent now, or kept to go by itself (`queued`) when it can't go yet. */
    async submit(body) {
      const me = account();
      if (!me) return { outcome: "signin" };
      const result = supportOutcome(await send(body).catch(() => null));
      if (result.outcome !== "retry") return result;
      if (waiting.length >= MAX_OUTBOX) return { outcome: "full" };
      waiting.push({ account: me, body, firstAt: now(), attempts: 1, nextAt: now() + RETRY_MS[0] });
      save();
      schedule();
      return { outcome: "queued" };
    },
    /** Sends what is due now (the sign-in came back, the app started); the timer does it otherwise. */
    flush,
    waiting: () => waiting.length,
    stop() { if (timer !== null) clearTimer(timer); timer = null; },
  };
}
