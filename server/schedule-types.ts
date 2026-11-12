export type ScheduleTarget = { botId: string; groupId?: never } | { groupId: string; botId?: never };
export type ScheduleRepeat = { kind: "once"; at: string } | { kind: "daily" | "weekdays"; time: string } | { kind: "weekly"; time: string; days: number[] } | { kind: "every"; hours: number };
export interface ResumeContext { botId: string; threadId: string; userMessageId: string; request: string; attempt: number }
export interface Schedule {
  id: string; target: ScheduleTarget; prompt: string; repeat: ScheduleRepeat; timezone: string;
  enabled: boolean; origin: "user" | "bot" | "auto-resume"; createdBy?: string;
  nextRunAt: string | null; graceMinutes: number; createdAt: string;
  resume?: ResumeContext;
  lastRun?: { at: string; outcome: "sent" | "queued" | "missed" | "failed"; note?: string };
}
export type ScheduleInput = Pick<Schedule, "target" | "prompt" | "repeat" | "timezone"> & Partial<Pick<Schedule, "enabled" | "graceMinutes">>;
export interface ScheduleDelivery {
  id: string; scheduleId: string; target: ScheduleTarget; prompt: string; dueAt: string; graceMinutes: number;
  resume?: ResumeContext; manual?: boolean; state: "pending" | "dispatching";
}
export interface ScheduleSnapshot { schedules: Schedule[]; paused: boolean; deliveries: ScheduleDelivery[] }
