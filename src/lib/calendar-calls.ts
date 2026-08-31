/** A calendar call opens a shared bot room and posts its seed prompt at the
 * scheduled time. Joining the room never starts audio automatically. */
export type CalendarCallSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] };

export type CalendarCallAttachmentKind = "file" | "image";

export interface CalendarCallAttachment {
  id: string;
  name: string;
  /** Local path kept as event-reference metadata. The calendar service never reads it. */
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
