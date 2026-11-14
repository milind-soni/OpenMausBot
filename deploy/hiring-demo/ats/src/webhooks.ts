// Wakes the Desk Manager in MausBot when something happens that no bot is already waiting for: a client
// requirement email, a phone-screen result, and the next-morning events. Failure never breaks the ATS.
import type { Store } from "./store.ts";
import type { DeskEvent } from "./types.ts";

interface Outgoing {
  type: string;
  key: string;
  body: Record<string, unknown>;
}

type WebhookConfig = { url: string | null; secret: string | null };

export function createWebhookNotifier(
  store: Store,
  cfg: WebhookConfig | (() => WebhookConfig),
  fetchImpl: typeof fetch = fetch,
  opts: { retryDelaysMs?: number[] } = {},
): { stop(): void; idle(): Promise<void> } {
  const retryDelays = opts.retryDelaysMs ?? [2_000, 4_000];
  let inFlight = Promise.resolve();
  const s = () => store.state;

  // A getter is read on every event, so a webhook address written after start (the hosted setup) is picked up.
  const read = typeof cfg === "function" ? cfg : () => cfg;
  if (!read().url) {
    store.log("Desk ATS", "Webhook not configured: the Desk Manager won't be woken automatically (set webhookUrl in config.json)");
    store.save();
  }

  function map(e: DeskEvent): Outgoing | null {
    if (e.name === "client_email_received") {
      const email = s().emails.find((x) => x.id === e.emailId);
      if (!email) return null;
      const sender = email.from.replace(/\s*<.*>/, "");
      return {
        type: "requirement.email_received",
        // Email ids restart at EM-0001 after every Reset; the arrival time makes each run's key unique,
        // otherwise MausBot drops the second run's event as a duplicate delivery.
        key: `requirement.email_received-${email.id}-${email.at}`,
        body: {
          summary: `New client requirement email ${email.id} from ${sender}: "${email.subject}"`,
          email_id: email.id, subject: email.subject, from: email.from, received_at: new Date(email.at).toISOString(),
        },
      };
    }
    if (e.name === "screen_logged" && e.detail?.channel === "voice") {
      const c = s().candidates.find((x) => x.id === e.candidateId);
      const req = s().requirements.find((r) => r.id === e.reqId);
      return {
        type: "screen.logged",
        // A repeated log of the same verdict must not wake the Desk Manager twice (two submission runs);
        // the requirement's arrival time keeps keys unique across Resets.
        key: `screen.logged-${req?.receivedAt ?? 0}-${e.reqId}-${e.candidateId}-${String(e.detail.verdict)}`,
        body: {
          summary: `Phone screen logged for ${c?.name ?? e.candidateId} on ${e.reqId}: ${String(e.detail.verdict)}`,
          req_id: e.reqId, candidate_id: e.candidateId, candidate_name: c?.name ?? null, verdict: e.detail.verdict,
        },
      };
    }
    if (e.name === "morning_events") {
      const d = e.detail ?? {};
      const feedback = s().emails.find((x) => x.id === d.feedbackEmailId);
      return {
        type: "desk.morning_events",
        key: `desk.morning_events-${String(d.feedbackEmailId)}-${feedback?.at ?? e.at}`,
        body: {
          summary: "Next-morning events: client interview feedback, an accepted offer, and month-end timesheets are due",
          feedback_email_id: d.feedbackEmailId, offer_accepted_email_id: d.offerAcceptedEmailId, timesheet_month: d.timesheetMonth,
        },
      };
    }
    return null;
  }

  async function deliver(out: Outgoing, target: WebhookConfig) {
    const headers: Record<string, string> = { "content-type": "application/json", "x-event-type": out.type, "idempotency-key": out.key };
    if (target.secret) headers.authorization = `Bearer ${target.secret}`;
    let reason = "";
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelays[attempt - 1]));
      try {
        const res = await fetchImpl(target.url!, { method: "POST", headers, body: JSON.stringify(out.body) });
        if (res.ok) {
          const receipt = (await res.json().catch(() => null)) as { duplicate?: boolean; ignored?: boolean; captured?: boolean } | null;
          const notStarted = receipt?.duplicate ? "MausBot treated it as a duplicate delivery"
            : receipt?.ignored ? "MausBot ignored it (is this event type enabled on the trigger?)"
            : receipt?.captured ? "MausBot only captured it as a sample (is the trigger switched on?)"
            : null;
          if (notStarted) {
            store.log("Desk ATS", `Desk Manager didn't start: ${notStarted}. Event ${out.type}`);
            store.save();
            store.emit({ name: "webhook_failed", detail: { type: out.type, reason: notStarted } });
            return;
          }
          store.log("Desk ATS", `Woke the Desk Manager: ${out.type}`);
          store.save();
          return;
        }
        reason = `HTTP ${res.status}`;
      } catch (err) {
        reason = (err as Error).message || "network error";
      }
    }
    store.log("Desk ATS", `Desk Manager not reachable (${reason}): event ${out.type} not delivered`);
    store.save();
    store.emit({ name: "webhook_failed", detail: { type: out.type, reason } });
  }

  const off = store.on((e) => {
    const target = read();
    if (!target.url) return;
    const out = map(e);
    if (out) inFlight = inFlight.then(() => deliver(out, target));
  });

  return {
    stop: off,
    idle: () => inFlight,
  };
}
