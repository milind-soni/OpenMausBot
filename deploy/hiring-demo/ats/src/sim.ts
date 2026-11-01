// The people outside the desk: the client, C2C vendors and candidates. Replies are queued in state.pending (so they
// survive a restart and vanish on reset) and delivered after a short delay. Also the two demo triggers.
import { DESK_ADDRESS, DeskError, type Desk } from "./desk.ts";
import type { Store } from "./store.ts";
import type { Email, EmailDraft, PendingReply } from "./types.ts";

export interface SimDelays {
  vendorReplyMs: [number, number];
  textReplyMs: number;
  rtrReplyMs: number;
  timesheetReplyMs: number;
}

export const DEFAULT_DELAYS: SimDelays = { vendorReplyMs: [8_000, 40_000], textReplyMs: 15_000, rtrReplyMs: 12_000, timesheetReplyMs: 10_000 };

export interface Sim {
  deliverClientEmail(): Email;
  deliverMorningEvents(): Email[];
  stop(): void;
}

type Timer = ReturnType<typeof setTimeout>;

export function createSim(
  store: Store,
  desk: Desk,
  opts: { delays?: Partial<SimDelays>; setTimer?: (fn: () => void, ms: number) => Timer; clearTimer?: (t: Timer) => void } = {},
): Sim {
  const delays: SimDelays = { ...DEFAULT_DELAYS, ...opts.delays };
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t: Timer) => clearTimeout(t));
  const timers = new Map<string, Timer>();
  const s = () => store.state;

  function arm(p: PendingReply) {
    timers.set(p.id, setTimer(() => fire(p.id), Math.max(0, p.dueAt - store.now())));
  }
  function fire(id: string) {
    timers.delete(id);
    const idx = s().pending.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const [p] = s().pending.splice(idx, 1);
    const e = desk.receiveEmail(p!.email);
    const who = s().candidates.find((c) => c.id === e.candidateId)?.name ?? e.from.replace(/\s*<.*>/, "");
    const consultants = s().script.vendorReplies.find((r) => r.vendorId === e.vendorId)?.consultants.length ?? 0;
    const line = {
      vendor_reply: `${s().vendors.find((v) => v.id === e.vendorId)?.name ?? who} replied with ${consultants} consultant${consultants === 1 ? "" : "s"}`,
      text_screen_reply: `${who} answered the text screen`,
      rtr_reply: `${who} confirmed the RTR and NDA${e.attachments.length ? ` (${e.attachments.length} docs attached)` : ""}`,
      timesheet_reply: `${who} sent their hours`,
    }[e.kind as string];
    if (line) {
      store.log("Inbox", `${line}${e.reqId ? ` · ${e.reqId}` : ""}`, { ...(e.reqId ? { reqId: e.reqId } : {}), ...(e.candidateId ? { candidateId: e.candidateId } : {}) });
      store.save();
    }
    store.emit({
      name: p!.fires, emailId: e.id,
      ...(e.reqId ? { reqId: e.reqId } : {}), ...(e.candidateId ? { candidateId: e.candidateId } : {}),
      ...(e.vendorId ? { detail: { vendorId: e.vendorId } } : {}),
    });
  }
  function schedule(email: EmailDraft, fires: PendingReply["fires"], delayMs: number) {
    const p: PendingReply = { id: store.nextId("PR"), dueAt: store.now() + delayMs, email, fires };
    s().pending.push(p);
    store.save();
    arm(p);
  }
  function clearAll() {
    for (const t of timers.values()) clearTimer(t);
    timers.clear();
  }

  const off = store.on((event) => {
    if (event.name === "reset") return clearAll();

    if (event.name === "vendor_mail_sent") {
      const mail = s().emails.find((e) => e.id === event.emailId);
      const mailed = new Set((event.detail?.vendorIds as string[] | undefined) ?? []);
      const script = s().script.vendorReplies;
      const [lo, hi] = delays.vendorReplyMs;
      script.forEach((reply, i) => {
        if (!mailed.has(reply.vendorId)) return;
        const vendor = s().vendors.find((v) => v.id === reply.vendorId)!;
        const delay = script.length > 1 ? lo + Math.round((i * (hi - lo)) / (script.length - 1)) : lo;
        schedule({
          kind: "vendor_reply", from: `${vendor.contact} <${vendor.email}>`, to: [DESK_ADDRESS], subject: `Re: ${mail?.subject ?? "Requirement"}`,
          body: reply.body, reqId: event.reqId, vendorId: vendor.id,
          attachments: reply.consultants.map((c) => ({ name: `${c.name} resume.html`, url: `/docs/${c.id}/resume` })),
        }, "vendor_reply_received", delay);
      });
      return;
    }

    if (event.name === "candidate_message_sent") {
      const c = s().candidates.find((x) => x.id === event.candidateId);
      const msg = s().emails.find((e) => e.id === event.emailId);
      const req = s().requirements.find((r) => r.id === event.reqId);
      if (!c || !msg || !req) return;
      const first = c.name.split(" ")[0];
      if (event.detail?.kind === "text_screen" && c.screenAnswers) {
        const a = c.screenAnswers;
        schedule({
          kind: "text_screen_reply", from: c.email, to: [DESK_ADDRESS], subject: `Re: ${msg.subject}`, reqId: req.id, candidateId: c.id, attachments: [],
          body: [
            `Hi, thanks for reaching out about the ${req.title} role.`,
            `- Interested: ${a.interested ? "Yes" : "Not right now, thanks"}`,
            `- Availability: ${a.availability}`,
            `- Notice period: ${a.noticePeriod}`,
            `- Rate: ${a.payExpectation}`,
            `- ${req.workMode === "remote" ? "Remote" : `${req.workMode === "hybrid" ? "Hybrid" : "Onsite"} in ${req.location}`}: ${a.locationOk ? "Yes, works for me" : "No, that won't work for me"}`,
            `- Work authorization: ${c.workAuth}${a.workAuthConfirmed ? ", valid" : ""}`,
            `- Notes: ${a.notes}`,
            first,
          ].join("\n"),
        }, "candidate_reply_received", delays.textReplyMs);
      }
      if (event.detail?.kind === "rtr") {
        schedule({
          kind: "rtr_reply", from: c.email, to: [DESK_ADDRESS], subject: `Re: ${msg.subject}`, reqId: req.id, candidateId: c.id,
          attachments: c.workAuthDocs,
          body: `Hi,\n\nI confirm that Recruiting Desk may represent me exclusively for ${req.id} (${req.title}, ${req.client}) at $${c.rateExpectation}/hr C2C. NDA signed.${c.workAuthDocs.length ? " My work authorization documents are attached." : " I'm a US citizen, so no visa documents are needed."}\n\n${first}`,
        }, "candidate_reply_received", delays.rtrReplyMs);
      }
      return;
    }

    if (event.name === "timesheet_requested") {
      const c = s().candidates.find((x) => x.id === event.candidateId);
      const month = String(event.detail?.month ?? "");
      if (!c) return;
      schedule({
        kind: "timesheet_reply", from: c.email, to: [DESK_ADDRESS], subject: `Re: Timesheet for ${month}`, reqId: event.reqId, candidateId: c.id, attachments: [],
        body: `Hi,\n\nHours for ${month}: 168 (21 working days x 8). Submitted in the client portal for approval.\n\n${c.name.split(" ")[0]}`,
      }, "candidate_reply_received", delays.timesheetReplyMs);
    }
  });

  for (const p of s().pending) arm(p);

  return {
    deliverClientEmail() {
      if (s().flags.clientEmailDelivered) throw new DeskError("Client email already delivered. Reset the demo first.");
      const e = desk.receiveEmail(s().script.heroClientEmail);
      s().flags.clientEmailDelivered = true;
      store.save();
      store.emit({ name: "client_email_received", emailId: e.id });
      return e;
    },
    deliverMorningEvents() {
      if (s().flags.morningDelivered) throw new DeskError("Next-morning events already delivered. Reset the demo first.");
      const m = s().script.morning;
      const feedback = desk.receiveEmail(m.feedbackEmail);
      const offer = desk.receiveEmail(m.offerAcceptedEmail);
      s().flags.morningDelivered = true;
      store.save();
      store.emit({ name: "morning_events", detail: { feedbackEmailId: feedback.id, offerAcceptedEmailId: offer.id, timesheetMonth: m.timesheetMonth } });
      return [feedback, offer];
    },
    stop() {
      clearAll();
      off();
    },
  };
}
