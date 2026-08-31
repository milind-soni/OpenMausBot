import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { nextOccurrence } from "./routines.ts";

export type CalendarCallSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] };

export type CalendarCallAttachmentKind = "file" | "image";

export interface CalendarCallAttachment {
  id: string;
  name: string;
  /** Stored as opaque event-reference metadata; this manager never opens the path. */
  path: string;
  size: number;
  kind: CalendarCallAttachmentKind;
}

export interface CalendarCall {
  id: string;
  name: string;
  description: string;
  botIds: string[];
  schedule: CalendarCallSchedule;
  durationMinutes: number;
  attachments: CalendarCallAttachment[];
  roomId?: string;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarCallInput {
  name: string;
  description?: string;
  botIds: string[];
  schedule: CalendarCallSchedule;
  durationMinutes?: number;
  attachments?: CalendarCallAttachment[];
}

export type CalendarCallPatch = Partial<CalendarCallInput>;

export interface CalendarCallManagerOptions {
  file?: string;
  now?: () => number;
  botExists: (botId: string) => boolean;
  onDue?: (call: CalendarCall, scheduledFor: number) => void | Promise<void>;
}

interface CalendarCallFile {
  version: 1;
  calls: CalendarCall[];
}

const MAX_BOTS = 100;
const MAX_ATTACHMENTS = 50;

const scheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), at: z.number().finite() }),
  z.object({
    type: z.literal("daily"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  }),
]);
const attachmentSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(255),
  path: z.string().trim().min(1).max(4_096),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(["file", "image"]),
});
const callSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  botIds: z.array(z.string().min(1)).min(1).max(MAX_BOTS),
  schedule: scheduleSchema,
  durationMinutes: z.number().int().min(15).max(240),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS),
  roomId: z.string().min(1).optional(),
  nextRunAt: z.number().finite().nonnegative().nullable().optional(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
});
const fileSchema = z.object({
  version: z.literal(1),
  calls: z.array(z.unknown()),
});

function cloneSchedule(schedule: CalendarCallSchedule): CalendarCallSchedule {
  return schedule.type === "once"
    ? { type: "once", at: schedule.at }
    : { type: "daily", time: schedule.time, weekdays: [...schedule.weekdays] };
}

function sameRoster(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const wanted = new Set(left);
  return right.every((id) => wanted.has(id));
}

function cloneCall(call: CalendarCall): CalendarCall {
  return {
    ...call,
    botIds: [...call.botIds],
    schedule: cloneSchedule(call.schedule),
    attachments: call.attachments.map((attachment) => ({ ...attachment })),
  };
}

function cleanSchedule(value: CalendarCallSchedule): CalendarCallSchedule {
  const parsed = scheduleSchema.safeParse(value);
  if (!parsed.success) throw new Error("Choose a valid call schedule");
  if (parsed.data.type === "once") return { type: "once", at: parsed.data.at };
  const weekdays = [...new Set(parsed.data.weekdays)].sort((a, b) => a - b);
  if (!weekdays.length) throw new Error("Choose at least one day");
  return { type: "daily", time: parsed.data.time, weekdays };
}

function cleanAttachments(value: CalendarCallAttachment[] | undefined): CalendarCallAttachment[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    throw new Error(`Add no more than ${MAX_ATTACHMENTS} attachments`);
  }
  const ids = new Set<string>();
  return value.map((candidate) => {
    const parsed = attachmentSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.name.includes("\0") || parsed.data.path.includes("\0")) {
      throw new Error("Choose a valid attachment");
    }
    if (ids.has(parsed.data.id)) throw new Error("Each attachment must be unique");
    ids.add(parsed.data.id);
    return { ...parsed.data };
  });
}

function cleanInput(
  input: CalendarCallInput,
  botExists: CalendarCallManagerOptions["botExists"],
): Omit<CalendarCall, "id" | "roomId" | "nextRunAt" | "createdAt" | "updatedAt"> {
  const name = String(input.name ?? "").trim().slice(0, 120);
  const description = String(input.description ?? "").trim().slice(0, 20_000);
  if (!name) throw new Error("Give the call a title");

  if (!Array.isArray(input.botIds)) throw new Error("Add at least one bot");
  const botIds = [...new Set(input.botIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (!botIds.length) throw new Error("Add at least one bot");
  if (botIds.length > MAX_BOTS) throw new Error(`Add no more than ${MAX_BOTS} bots`);
  if (botIds.some((botId) => !botExists(botId))) throw new Error("One or more bots no longer exist");

  const duration = input.durationMinutes ?? 30;
  if (!Number.isInteger(duration) || duration < 15 || duration > 240) {
    throw new Error("Call duration must be between 15 and 240 minutes");
  }

  return {
    name,
    description,
    botIds,
    schedule: cleanSchedule(input.schedule),
    durationMinutes: duration,
    attachments: cleanAttachments(input.attachments),
  };
}

export class CalendarCallManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly botExists: CalendarCallManagerOptions["botExists"];
  private readonly onDue: CalendarCallManagerOptions["onDue"];
  private calls: CalendarCall[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: CalendarCallManagerOptions) {
    this.file = options.file ?? join(DATA_DIR, "calendar-calls.json");
    this.now = options.now ?? Date.now;
    this.botExists = options.botExists;
    this.onDue = options.onDue;
    let migrated = false;
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      this.calls = parsed.success
        ? parsed.data.calls.flatMap((candidate) => {
            const call = callSchema.safeParse(candidate);
            if (!call.success) return [];
            if (call.data.nextRunAt === undefined) migrated = true;
            const nextRunAt = call.data.nextRunAt === undefined
              ? this.loadedOccurrence(call.data.schedule)
              : call.data.nextRunAt;
            return [cloneCall({ ...call.data, nextRunAt })];
          })
        : [];
    } catch {
      this.calls = [];
    }
    if (migrated) {
      try {
        this.save();
      } catch (error) {
        console.error("calendar calls: could not persist schedule migration", error);
      }
    }
  }

  list(): CalendarCall[] {
    return this.calls.map(cloneCall);
  }

  get(id: string): CalendarCall | null {
    const call = this.calls.find((candidate) => candidate.id === id);
    return call ? cloneCall(call) : null;
  }

  create(input: CalendarCallInput): CalendarCall {
    const clean = cleanInput(input, this.botExists);
    const timestamp = this.now();
    const call: CalendarCall = {
      id: randomUUID(),
      ...clean,
      nextRunAt: this.initialOccurrence(clean.schedule, timestamp),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.commit(() => this.calls.push(call));
    if (this.timer) queueMicrotask(() => void this.tick());
    return cloneCall(call);
  }

  update(id: string, patch: CalendarCallPatch): CalendarCall {
    const index = this.calls.findIndex((call) => call.id === id);
    if (index < 0) throw new Error("Call not found");
    const previous = this.calls[index]!;
    const clean = cleanInput({
      name: patch.name ?? previous.name,
      description: patch.description ?? previous.description,
      botIds: patch.botIds ?? previous.botIds,
      schedule: patch.schedule ?? previous.schedule,
      durationMinutes: patch.durationMinutes ?? previous.durationMinutes,
      attachments: patch.attachments ?? previous.attachments,
    }, this.botExists);
    const updated: CalendarCall = {
      id: previous.id,
      ...clean,
      roomId: patch.botIds && !sameRoster(clean.botIds, previous.botIds) ? undefined : previous.roomId,
      nextRunAt: this.initialOccurrence(clean.schedule, this.now()),
      createdAt: previous.createdAt,
      updatedAt: this.now(),
    };
    this.commit(() => {
      this.calls[index] = updated;
    });
    if (this.timer) queueMicrotask(() => void this.tick());
    return cloneCall(updated);
  }

  linkRoom(id: string, roomId: string): CalendarCall {
    const call = this.calls.find((candidate) => candidate.id === id);
    if (!call) throw new Error("Call not found");
    if (call.roomId === roomId) return cloneCall(call);
    this.commit(() => {
      call.roomId = roomId;
    });
    return cloneCall(call);
  }

  remove(id: string): boolean {
    const index = this.calls.findIndex((call) => call.id === id);
    if (index < 0) return false;
    this.commit(() => {
      this.calls.splice(index, 1);
    });
    return true;
  }

  /** Keep calendar plans usable when a participant is archived permanently.
   * A call with other guests survives; an empty call no longer has meaning. */
  removeBot(botId: string): number {
    const affected = this.calls.filter((call) => call.botIds.includes(botId)).length;
    if (!affected) return 0;
    this.commit(() => {
      this.calls = this.calls.flatMap((call) => {
        if (!call.botIds.includes(botId)) return [call];
        const botIds = call.botIds.filter((id) => id !== botId);
        return botIds.length ? [{ ...call, botIds, updatedAt: this.now() }] : [];
      });
    });
    return affected;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const call of this.calls) {
        if (call.nextRunAt == null || call.nextRunAt > now) continue;
        const scheduledFor = call.nextRunAt;
        if (now - scheduledFor < call.durationMinutes * 60_000) {
          try {
            await this.onDue?.(cloneCall(call), scheduledFor);
          } catch (error) {
            console.error(`calendar call ${call.id}: scheduled room kickoff failed`, error);
            continue;
          }
        }
        call.nextRunAt = call.schedule.type === "once"
          ? null
          : nextOccurrence(call.schedule, Math.max(now, scheduledFor));
        this.save();
      }
    } finally {
      this.ticking = false;
    }
  }

  private initialOccurrence(schedule: CalendarCallSchedule, now: number): number | null {
    return schedule.type === "once" ? schedule.at : nextOccurrence(schedule, now);
  }

  /** Old calendar calls were reminders only. Start recurring reminders from
   * the next future slot and never replay an already-past one-time reminder. */
  private loadedOccurrence(schedule: CalendarCallSchedule): number | null {
    const now = this.now();
    if (schedule.type === "once") return schedule.at > now ? schedule.at : null;
    return nextOccurrence(schedule, now);
  }

  private commit(mutate: () => void): void {
    const before = this.calls.map(cloneCall);
    try {
      mutate();
      this.save();
    } catch (error) {
      this.calls = before;
      throw error;
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, calls: this.calls } satisfies CalendarCallFile, null, 2), {
      mode: 0o600,
    });
  }
}
