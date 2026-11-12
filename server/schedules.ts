import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { newId } from "./contracts.ts";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import { nextScheduleRun, resumeDelay } from "./schedule-time.ts";
import type { ResumeContext, Schedule, ScheduleDelivery, ScheduleInput, ScheduleSnapshot } from "./schedule-types.ts";
export type { Schedule, ScheduleDelivery, ScheduleInput } from "./schedule-types.ts";

export function validateSchedule(input: ScheduleInput) {
  if (!input || !input.target || (typeof input.target.botId === "string") === (typeof input.target.groupId === "string")) throw new Error("Choose a bot or room.");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 30_000) throw new Error("Write instructions of up to 30,000 characters.");
  if (typeof input.timezone !== "string") throw new Error("Choose a timezone.");
  new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format();
  const r = input.repeat;
  if (!r || !["once", "daily", "weekdays", "weekly", "every"].includes(r.kind)) throw new Error("Choose when it should run.");
  if (r.kind === "once" && (!Number.isFinite(Date.parse(r.at)) || !/([zZ]|[+-]\d\d:\d\d)$/.test(r.at))) throw new Error("Choose a date and time with a timezone.");
  if (r.kind === "every" && (!Number.isInteger(r.hours) || r.hours < 1 || r.hours > 168)) throw new Error("Choose an interval from 1 to 168 hours.");
  if ("time" in r && !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)) throw new Error("Choose a valid time.");
  if (r.kind === "weekly" && (!Array.isArray(r.days) || !r.days.length || r.days.some(d => !Number.isInteger(d) || d < 0 || d > 6))) throw new Error("Choose at least one weekday.");
  if (input.graceMinutes !== undefined && (!Number.isInteger(input.graceMinutes) || input.graceMinutes < 0 || input.graceMinutes > 1440)) throw new Error("Choose a catch-up window from 0 to 1440 minutes.");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("Choose whether the schedule is on.");
}
export function canManageSchedule(schedule: Pick<Schedule, "target" | "createdBy">, botId: string, rooms: Array<{ id: string; memberIds: string[] }>) {
  return schedule.createdBy === botId && (schedule.target.botId === botId || Boolean(schedule.target.groupId && rooms.some(r => r.id === schedule.target.groupId && r.memberIds.includes(botId))));
}
export class ScheduleStore {
  private file: string;
  private data: ScheduleSnapshot;
  private now: () => number;
  onChange: () => void = () => {};
  constructor(directory: string, now: () => number = Date.now) {
    this.now = now; mkdirSync(directory, { recursive: true }); this.file = join(directory, "schedules.json");
    const raw = readJsonFile<ScheduleSnapshot>(this.file, { paused: false, schedules: [], deliveries: [] });
    this.data = { paused: raw?.paused === true, schedules: Array.isArray(raw?.schedules) ? raw.schedules.filter(s => { try { validateSchedule(s); return typeof s.id === "string" && Number.isFinite(Date.parse(s.createdAt)) && (s.nextRunAt === null || Number.isFinite(Date.parse(s.nextRunAt))); } catch { return false; } }) : [], deliveries: Array.isArray(raw?.deliveries) ? raw.deliveries.filter(j => j && typeof j.id === "string" && typeof j.scheduleId === "string" && typeof j.prompt === "string" && j.target && Number.isFinite(Date.parse(j.dueAt)) && ["pending", "dispatching"].includes(j.state)) : [] };
    // A crash after dispatch may have performed actions. Never replay that work automatically.
    for (const job of this.data.deliveries.filter(j => j.state === "dispatching")) this.outcome(job, "failed", "The app closed while this run was starting. Review the chat before running it again.");
    this.data.deliveries = this.data.deliveries.filter(j => j.state === "pending");
    this.save();
  }
  snapshot(): ScheduleSnapshot { return structuredClone(this.data); }
  private save() { writeJsonAtomic(this.file, this.data); this.onChange(); }
  get(id: string) { return this.data.schedules.find(s => s.id === id); }
  create(input: ScheduleInput, origin: Schedule["origin"] = "user", createdBy?: string): Schedule {
    validateSchedule(input);
    const owner = createdBy ?? input.target.botId;
    if (owner && this.data.schedules.filter(s => (s.createdBy ?? s.target.botId) === owner && s.enabled).length >= 20) throw new Error("Each bot can have up to 20 active schedules.");
    const now = this.now(), nextRunAt = nextScheduleRun(input.repeat, input.timezone, now);
    if (!nextRunAt) throw new Error("Choose a future run time.");
    const schedule: Schedule = { id: newId(), target: input.target, prompt: input.prompt.trim(), repeat: input.repeat, timezone: input.timezone, enabled: input.enabled ?? true, graceMinutes: input.graceMinutes ?? 120, origin, createdBy, nextRunAt, createdAt: new Date(now).toISOString() };
    this.data.schedules.push(schedule); this.save(); return structuredClone(schedule);
  }
  update(id: string, patch: Partial<ScheduleInput>) {
    const old = this.get(id); if (!old) throw new Error("Schedule not found.");
    if (old.origin === "auto-resume") throw new Error("Cancel this automatic retry and create a new schedule instead.");
    const input = { ...old, ...patch }; validateSchedule(input);
    if (!old.enabled && input.enabled && old.createdBy && this.data.schedules.filter(s => s.enabled && s.createdBy === old.createdBy).length >= 20) throw new Error("Each bot can have up to 20 active schedules.");
    const nextRunAt = nextScheduleRun(input.repeat, input.timezone, this.now());
    if (input.enabled && !nextRunAt) throw new Error("Choose a future run time.");
    Object.assign(old, { target: input.target, prompt: input.prompt.trim(), repeat: input.repeat, timezone: input.timezone, enabled: input.enabled, graceMinutes: input.graceMinutes, nextRunAt });
    this.data.deliveries = this.data.deliveries.filter(j => j.scheduleId !== id || j.state === "dispatching");
    this.save(); return structuredClone(old);
  }
  remove(id: string) { this.data.schedules = this.data.schedules.filter(s => s.id !== id); this.data.deliveries = this.data.deliveries.filter(j => j.scheduleId !== id || j.state === "dispatching"); this.save(); }
  cancelResume(threadId: string) { for (const s of [...this.data.schedules]) if (s.origin === "auto-resume" && s.resume?.threadId === threadId) this.remove(s.id); }
  pause(paused: boolean) { this.data.paused = paused; this.save(); }
  upsertResume(target: Schedule["target"], resume: ResumeContext, resetsAt?: string) {
    let old = this.data.schedules.find(s => s.origin === "auto-resume" && s.resume?.threadId === resume.threadId);
    const attempt = old?.resume?.userMessageId === resume.userMessageId ? old.resume.attempt + 1 : resume.attempt;
    const now = this.now(), at = resetsAt && Date.parse(resetsAt) > now ? Date.parse(resetsAt) + 120_000 : now + resumeDelay(attempt);
    const input: ScheduleInput = { target, prompt: `Continue where you left off. The interrupted request was:\n\n${resume.request}`, repeat: { kind: "once", at: new Date(at).toISOString() }, timezone: "UTC" };
    if (!old) { const made = this.create(input, "auto-resume", resume.botId); old = this.get(made.id)!; }
    if (!old.enabled && this.data.schedules.filter(s => s.createdBy === resume.botId && s.enabled).length >= 20) throw new Error("Each bot can have up to 20 active schedules.");
    Object.assign(old, input, { enabled: true, nextRunAt: new Date(at).toISOString(), resume: { ...resume, attempt } });
    this.data.deliveries = this.data.deliveries.filter(j => j.scheduleId !== old!.id || j.state === "dispatching");
    this.save(); return structuredClone(old);
  }
  private outcome(job: ScheduleDelivery, outcome: NonNullable<Schedule["lastRun"]>["outcome"], note?: string) {
    const s = this.get(job.scheduleId); if (s) s.lastRun = { at: new Date(this.now()).toISOString(), outcome, note };
  }
  runNow(id: string) {
    const schedule = this.get(id); if (!schedule) throw new Error("Schedule not found.");
    const queued = this.data.deliveries.find(j => j.scheduleId === id);
    if (queued) { if (queued.state === "pending") { queued.manual = true; queued.dueAt = new Date(this.now()).toISOString(); this.save(); } return; }
    this.enqueue(schedule, new Date(this.now()).toISOString(), true);
    if (schedule.repeat.kind === "once") { schedule.enabled = false; schedule.nextRunAt = null; }
    this.save();
  }
  private enqueue(s: Schedule, dueAt: string, manual = false) {
    const job: ScheduleDelivery = { id: newId(), scheduleId: s.id, target: s.target, prompt: s.prompt, dueAt, graceMinutes: s.graceMinutes, resume: s.resume, manual, state: "pending" };
    this.data.deliveries.push(job); this.outcome(job, "queued");
  }
  collectDue() {
    if (this.data.paused) return;
    const now = this.now(); let changed = false;
    for (const s of this.data.schedules) {
      if (!s.enabled || !s.nextRunAt || Date.parse(s.nextRunAt) > now) continue;
      const due = s.nextRunAt;
      if (now - Date.parse(due) <= s.graceMinutes * 60_000) this.enqueue(s, due);
      else s.lastRun = { at: due, outcome: "missed", note: "This run was outside its catch-up window." };
      s.nextRunAt = nextScheduleRun(s.repeat, s.timezone, now, Date.parse(s.createdAt));
      if (!s.nextRunAt) s.enabled = false;
      changed = true;
    }
    if (changed) this.save();
  }
  pending() { return this.data.deliveries.filter(j => j.state === "pending" && (!this.data.paused || j.manual)).map(j => structuredClone(j)); }
  claim(id: string) { const j = this.data.deliveries.find(j => j.id === id); if (j) { j.state = "dispatching"; this.save(); } }
  finish(id: string, outcome: "sent" | "failed" | "missed", note?: string) {
    const job = this.data.deliveries.find(j => j.id === id); if (!job) return;
    this.outcome(job, outcome, note); this.data.deliveries = this.data.deliveries.filter(j => j.id !== id); this.save();
  }
}

/** One wake timer; due work and queued deliveries remain server-owned. */
export class Scheduler {
  private store: ScheduleStore; private timer?: ReturnType<typeof setTimeout>; private running = false; private stopped = true; private rerun = false;
  private deliver: (job: ScheduleDelivery) => Promise<boolean>; private now: () => number;
  constructor(store: ScheduleStore, deliver: (job: ScheduleDelivery) => Promise<boolean>, now: () => number = Date.now) { this.store = store; this.deliver = deliver; this.now = now; }
  start() { this.stopped = false; void this.wake(); }
  stop() { this.stopped = true; clearTimeout(this.timer); }
  async wake() {
    if (this.stopped) return;
    if (this.running) { this.rerun = true; return; }
    this.running = true; clearTimeout(this.timer);
    try {
      this.store.collectDue();
      for (const job of this.store.pending()) {
        if (!job.manual && this.now() - Date.parse(job.dueAt) > job.graceMinutes * 60_000) { this.store.finish(job.id, "missed", "This queued run was outside its catch-up window."); continue; }
        try { await this.deliver(job); } catch { this.store.finish(job.id, "failed", "Could not start this run. Check the chat and the selected AI app."); }
      }
    } finally { this.running = false; this.arm(); if (this.rerun) { this.rerun = false; queueMicrotask(() => void this.wake()); } }
  }
  arm() {
    clearTimeout(this.timer); if (this.stopped || this.store.snapshot().paused) return;
    const times = this.store.snapshot().schedules.filter(s => s.enabled && s.nextRunAt).map(s => Date.parse(s.nextRunAt!));
    if (times.length) { this.timer = setTimeout(() => void this.wake(), Math.max(1, Math.min(2147483647, Math.min(...times) - this.now()))); this.timer.unref(); }
  }
}
