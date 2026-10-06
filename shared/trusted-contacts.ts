import { z } from "zod";

export const contactCapabilitySchema = z.enum(["availability", "propose"]);
const time = z.number().int().nonnegative().max(8_640_000_000_000_000);
export const timeSlotSchema = z.object({ start: time, end: time }).strict().refine(v => v.end > v.start, "End must follow start");
export type TimeSlot = z.infer<typeof timeSlotSchema>;
const boundedWindow = (v: TimeSlot) => v.end > v.start && v.end - v.start <= 31 * 86400000;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const contactRequestSchema = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("availability"), start: time, end: time, durationMinutes: z.number().int().min(15).max(240) }).strict(),
  z.object({ id, kind: z.literal("proposal"), start: time, end: time, subject: z.string().trim().min(1).max(200) }).strict(),
]).refine(boundedWindow, "Request window must be between zero and 31 days");
export type ContactRequestInput = z.infer<typeof contactRequestSchema>;
export const contactInputSchema = z.object({ name: z.string().trim().min(1).max(80), botId: id, phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional() }).strict();
export const contactGrantSchema = z.object({ capabilities: z.array(contactCapabilitySchema).min(1).max(2), start: time, end: time, expiresAt: time }).strict().refine(boundedWindow, "Grant window must be between zero and 31 days");
export type ContactGrant = z.infer<typeof contactGrantSchema>;
export const availabilityConfigSchema = z.object({
  botId: id, source: z.enum(["manual", "google"]), slots: z.array(timeSlotSchema).max(200),
  accountId: z.string().trim().min(1).max(128).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), "Account names cannot contain control characters").optional(),
  calendarIds: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
}).strict();
export type AvailabilityConfig = z.infer<typeof availabilityConfigSchema>;
export interface TrustedContact { id: string; name: string; botId: string; phone?: string; disabled: boolean; grant?: ContactGrant; }
export const contactReplySchema = z.object({
  id: z.string().uuid(), status: z.enum(["pending", "completed", "denied", "expired", "cancelled"]),
  text: z.string().max(4000), slots: z.array(timeSlotSchema).max(100).optional(),
}).strict();
export type ContactReply = z.infer<typeof contactReplySchema>;
export interface ContactRequestRecord {
  id: string; contactId: string; input: ContactRequestInput; fingerprint: string;
  status: ContactReply["status"]; createdAt: number; expiresAt: number;
  decidedAt?: number; reply: ContactReply;
}
export interface TrustedContactsSnapshot {
  contacts: TrustedContact[]; calendars: AvailabilityConfig[]; requests: ContactRequestRecord[];
}
