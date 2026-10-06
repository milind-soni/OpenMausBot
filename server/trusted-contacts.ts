// Original Mausbot contact scheduling. External text never starts an agent turn.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import {
  availabilityConfigSchema, contactGrantSchema, contactInputSchema, contactReplySchema, contactRequestSchema,
  type AvailabilityConfig, type ContactGrant, type ContactReply, type ContactRequestInput,
  type ContactRequestRecord, type TimeSlot, type TrustedContact, type TrustedContactsSnapshot,
} from "../shared/trusted-contacts.ts";

export class ContactError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);
const storedContact = contactInputSchema.extend({ id: z.string().uuid(), disabled: z.boolean(), tokenHash: z.string().regex(/^[a-f0-9]{64}$/), grant: contactGrantSchema.optional() });
const storedRequest = z.object({
  id: z.string().uuid(), contactId: z.string().uuid(), input: contactRequestSchema, fingerprint: z.string(),
  status: contactReplySchema.shape.status, createdAt: z.number(), expiresAt: z.number(), decidedAt: z.number().optional(), reply: contactReplySchema,
});
const stateSchema = z.object({ version: z.literal(1), contacts: z.array(storedContact).max(200), calendars: z.array(availabilityConfigSchema).max(200), requests: z.array(storedRequest).max(10000) });
type State = z.infer<typeof stateSchema>;
export interface TrustedContactsOptions {
  file: string; now?: () => number; botExists(id: string): boolean;
  busy?: (config: AvailabilityConfig, window: TimeSlot) => Promise<TimeSlot[]>;
}
export class TrustedContacts {
  private state: State;
  private deciding = new Set<string>();
  private receiving = new Set<string>();
  private attempts = new Map<string, number[]>();
  private now: () => number;
  private options: TrustedContactsOptions;
  constructor(options: TrustedContactsOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.state = existsSync(options.file) ? stateSchema.parse(JSON.parse(readFileSync(options.file, "utf8"))) : { version: 1, contacts: [], calendars: [], requests: [] };
  }
  private save(next: State) {
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.options.file, JSON.stringify(next), { mode: 0o600 });
    this.state = next;
  }
  snapshot(): TrustedContactsSnapshot {
    return clone({ contacts: this.state.contacts.map(({ tokenHash: _token, ...contact }) => contact), calendars: this.state.calendars, requests: this.state.requests.map(r => this.current(r)) });
  }
  createContact(input: unknown): { contact: TrustedContact; token: string } {
    const parsed = contactInputSchema.parse(input);
    if (!this.options.botExists(parsed.botId)) throw new ContactError("Bot is unavailable", 404);
    if (this.state.contacts.length >= 200) throw new ContactError("Contact limit reached", 409);
    if (parsed.phone && this.state.contacts.some(c => !c.disabled && c.phone === parsed.phone)) throw new ContactError("This phone number already has a contact", 409);
    const token = randomBytes(32).toString("base64url");
    const contact = { ...parsed, id: randomUUID(), disabled: false };
    const next = clone(this.state); next.contacts.push({ ...contact, tokenHash: hash(token) }); this.save(next);
    return { contact, token };
  }
  private contact(id: string) {
    const contact = this.state.contacts.find(c => c.id === id);
    if (!contact || contact.disabled || !this.options.botExists(contact.botId)) throw new ContactError("Contact is unavailable", 404);
    return contact;
  }
  authenticate(token: string): string {
    if (!/^[\w-]{43}$/.test(token)) throw new ContactError("Invalid contact credential", 401);
    const digest = Buffer.from(hash(token), "hex");
    const contact = this.state.contacts.find(c => timingSafeEqual(Buffer.from(c.tokenHash, "hex"), digest));
    if (!contact || contact.disabled || !this.options.botExists(contact.botId)) throw new ContactError("Invalid contact credential", 401);
    return contact.id;
  }
  contactForPhone(phone: string): string | null { return this.state.contacts.find(c => !c.disabled && c.phone === phone)?.id ?? null; }
  rotate(id: string): string {
    this.contact(id); const token = randomBytes(32).toString("base64url");
    const next = clone(this.state); next.contacts.find(c => c.id === id)!.tokenHash = hash(token); this.save(next); return token;
  }
  grant(id: string, value: unknown) {
    this.contact(id); const grant = contactGrantSchema.parse(value);
    if (grant.expiresAt <= this.now()) throw new ContactError("Grant expiry must be in the future");
    const next = clone(this.state); next.contacts.find(c => c.id === id)!.grant = grant; this.save(next);
  }
  revoke(id: string, disable = false) {
    this.contact(id); const next = clone(this.state); const contact = next.contacts.find(c => c.id === id)!;
    delete contact.grant; contact.disabled = disable; this.save(next);
  }
  configure(value: unknown) {
    const config = availabilityConfigSchema.parse(value);
    if (!this.options.botExists(config.botId)) throw new ContactError("Bot is unavailable", 404);
    if (this.state.calendars.length >= 200 && !this.state.calendars.some(c => c.botId === config.botId)) throw new ContactError("Calendar configuration limit reached", 409);
    const next = clone(this.state); next.calendars = next.calendars.filter(c => c.botId !== config.botId); next.calendars.push(config); this.save(next);
  }
  private calendarRevision(contactId: string) {
    const botId = this.contact(contactId).botId;
    return JSON.stringify(this.state.calendars.find(c => c.botId === botId));
  }
  private allowed(contactId: string, input: ContactRequestInput): { contact: State["contacts"][number]; grant: ContactGrant } {
    const contact = this.contact(contactId); const grant = contact.grant;
    const capability = input.kind === "availability" ? "availability" : "propose";
    if (!grant || grant.expiresAt <= this.now() || !grant.capabilities.includes(capability) || input.start < grant.start || input.end > grant.end) throw new ContactError("No active grant covers this request", 403);
    return { contact, grant };
  }
  private current(row: ContactRequestRecord): ContactRequestRecord {
    if (row.status === "pending" && row.expiresAt <= this.now()) return { ...row, status: "expired", reply: { id: row.id, status: "expired", text: "This request expired." } };
    return row;
  }
  async receive(token: string, value: unknown): Promise<ContactReply> {
    const reply = await this.receiveFrom(this.authenticate(token), value);
    this.authenticate(token); // Rotation also invalidates a read already waiting on the calendar.
    return reply;
  }
  // Called by the verified carrier adapter only, never with an ID supplied in message text.
  async receiveFrom(contactId: string, value: unknown): Promise<ContactReply> {
    this.contact(contactId);
    if (this.receiving.has(contactId)) throw new ContactError("Another contact request is in progress", 409);
    this.receiving.add(contactId);
    try { return await this.receiveOne(contactId, value); } finally { this.receiving.delete(contactId); }
  }
  private async receiveOne(contactId: string, value: unknown): Promise<ContactReply> {
    const input = contactRequestSchema.parse(value);
    this.allowed(contactId, input);
    const fingerprint = hash(JSON.stringify(input));
    const duplicate = () => {
      const row = this.state.requests.find(r => r.contactId === contactId && r.input.id === input.id);
      if (row && row.fingerprint !== fingerprint) throw new ContactError("Request ID already has different content", 409);
      return row;
    };
    const old = duplicate(); if (old) return clone(this.current(old).reply);
    if (this.state.requests.length >= 10000) throw new ContactError("Request history is full", 429);
    if (this.state.requests.filter(r => r.contactId === contactId && r.createdAt > this.now() - 3600000).length >= 60) throw new ContactError("Contact request limit reached", 429);
    const attempts = (this.attempts.get(contactId) ?? []).filter(at => at > this.now() - 3600000);
    if (attempts.length >= 60) throw new ContactError("Contact request limit reached", 429);
    attempts.push(this.now()); this.attempts.set(contactId, attempts);
    const calendarRevision = this.calendarRevision(contactId);
    const slots = input.kind === "availability" ? await this.slots(contactId, input) : undefined;
    const { grant } = this.allowed(contactId, input);
    if (input.kind === "availability" && this.calendarRevision(contactId) !== calendarRevision) throw new ContactError("Calendar settings changed; retry the request", 409);
    const raced = duplicate(); if (raced) return clone(this.current(raced).reply);
    if (this.state.requests.length >= 10000 || this.state.requests.filter(r => r.contactId === contactId && r.createdAt > this.now() - 3600000).length >= 60) throw new ContactError("Contact request limit reached", 429);
    const id = randomUUID();
    const reply: ContactReply = input.kind === "proposal" ? { id, status: "pending", text: "Your meeting proposal is waiting for the owner's approval." } : { id, status: "completed", slots, text: slots!.length ? "Available times are attached." : "No available times in this window." };
    const row: ContactRequestRecord = { id, contactId, input, fingerprint, status: reply.status, createdAt: this.now(), expiresAt: Math.min(grant.expiresAt, this.now() + 86400000, input.start), reply };
    if (input.end <= this.now() || (input.kind === "proposal" && row.expiresAt <= this.now())) throw new ContactError("Request is in the past");
    const next = clone(this.state); next.requests.push(row); this.save(next); return clone(reply);
  }
  private async free(contactId: string, input: ContactRequestInput): Promise<TimeSlot[]> {
    const { contact } = this.allowed(contactId, input);
    const config = this.state.calendars.find(c => c.botId === contact.botId);
    if (!config) throw new ContactError("Calendar availability has not been configured", 409);
    const revision = JSON.stringify(config);
    let busy: TimeSlot[] = [];
    if (config.source === "google") {
      if (!this.options.busy) throw new ContactError("Calendar connection is unavailable", 503);
      busy = await this.options.busy(clone(config), { start: input.start, end: input.end });
    }
    this.allowed(contactId, input);
    if (JSON.stringify(this.state.calendars.find(c => c.botId === contact.botId)) !== revision) throw new ContactError("Calendar settings changed; retry the request", 409);
    const reserved = this.state.requests.filter(r => r.status === "completed" && r.input.kind === "proposal" && this.state.contacts.find(c => c.id === r.contactId)?.botId === contact.botId).map(r => ({ start: r.input.start, end: r.input.end }));
    const windows = mergeIntervals(config.slots.map(s => ({ start: Math.max(s.start, input.start, this.now()), end: Math.min(s.end, input.end) })).filter(s => s.end > s.start));
    return subtractIntervals(windows, [...busy, ...reserved]);
  }
  private async slots(contactId: string, input: ContactRequestInput & { kind: "availability" }): Promise<TimeSlot[]> {
    const free = await this.free(contactId, input); const duration = input.durationMinutes * 60000; const slots: TimeSlot[] = [];
    for (const window of free) for (let start = window.start; start + duration <= window.end && slots.length < 100; start += duration) slots.push({ start, end: start + duration });
    return slots;
  }
  async decide(id: string, decision: "approve" | "deny"): Promise<ContactReply> {
    const row = this.state.requests.find(r => r.id === id);
    const botId = row && this.state.contacts.find(c => c.id === row.contactId)?.botId;
    if (!botId) throw new ContactError("Unknown request", 404);
    if (this.deciding.has(botId)) throw new ContactError("Another meeting decision is in progress; retry shortly", 409);
    this.deciding.add(botId);
    try { return await this.settle(id, decision); } finally { this.deciding.delete(botId); }
  }
  private async settle(id: string, decision: "approve" | "deny"): Promise<ContactReply> {
    const row = this.state.requests.find(r => r.id === id);
    if (!row || row.input.kind !== "proposal" || this.current(row).status !== "pending") throw new ContactError("Request is not pending", 409);
    if (decision === "approve") {
      this.allowed(row.contactId, row.input);
      const revision = this.calendarRevision(row.contactId);
      const free = await this.free(row.contactId, row.input);
      this.allowed(row.contactId, row.input);
      if (this.calendarRevision(row.contactId) !== revision) throw new ContactError("Calendar settings changed; retry the decision", 409);
      // free() rechecks authority after I/O and reads current reservations.
      if (!free.some(s => s.start <= row.input.start && s.end >= row.input.end)) throw new ContactError("The proposed time is no longer available", 409);
    }
    const current = this.state.requests.find(r => r.id === id)!;
    if (this.current(current).status !== "pending") throw new ContactError("Request is not pending", 409);
    const next = clone(this.state); const settled = next.requests.find(r => r.id === id)!;
    settled.status = decision === "approve" ? "completed" : "denied"; settled.decidedAt = this.now();
    settled.reply = { id, status: settled.status, text: decision === "approve" ? `Confirmed: ${row.input.subject}. Download the calendar invitation; it has not been added to an external calendar.` : "The owner declined this meeting." };
    this.save(next); return clone(settled.reply);
  }
  result(token: string, id: string): ContactReply {
    const contactId = this.authenticate(token); return this.resultFor(contactId, id);
  }
  resultFor(contactId: string, id: string): ContactReply {
    const row = this.state.requests.find(r => r.id === id && r.contactId === contactId);
    if (!row) throw new ContactError("Unknown request", 404);
    this.allowed(contactId, row.input); return clone(this.current(row).reply);
  }
  invitation(id: string): string {
    const row = this.state.requests.find(r => r.id === id);
    if (!row || row.status !== "completed" || row.input.kind !== "proposal") throw new ContactError("No confirmed meeting", 404);
    const stamp = (at: number) => new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const escape = (text: string) => text.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/[,;]/g, "\\$&").replace(/\r/g, "");
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//OpenMausBot//Trusted Contacts//EN", "BEGIN:VEVENT", `UID:${row.id}@openmausbot`, `DTSTAMP:${stamp(row.createdAt)}`, `DTSTART:${stamp(row.input.start)}`, `DTEND:${stamp(row.input.end)}`, `SUMMARY:${escape(row.input.subject)}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  }
}
export function mergeIntervals(slots: TimeSlot[]): TimeSlot[] {
  const out: TimeSlot[] = [];
  for (const slot of [...slots].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1); if (last && slot.start <= last.end) last.end = Math.max(last.end, slot.end); else out.push({ start: slot.start, end: slot.end });
  }
  return out;
}
export function subtractIntervals(windows: TimeSlot[], busy: TimeSlot[]): TimeSlot[] {
  let free = windows;
  for (const blocked of mergeIntervals(busy)) free = free.flatMap(s => blocked.end <= s.start || blocked.start >= s.end ? [s] : [
    ...(blocked.start > s.start ? [{ start: s.start, end: blocked.start }] : []),
    ...(blocked.end < s.end ? [{ start: blocked.end, end: s.end }] : []),
  ]);
  return free;
}
