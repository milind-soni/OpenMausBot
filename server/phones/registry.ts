import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

import { PHONE_CAPABILITIES, PHONE_PLATFORMS } from "../../shared/phone-apps.ts";
import { writeFileAtomic } from "../atomic.ts";

const KNOWN_CAPABILITIES: readonly string[] = PHONE_CAPABILITIES;
/** Only the apps this server knows: a newer phone's extra app is dropped, never a reason to refuse the rest. */
const knownCapabilities = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([capability]) => KNOWN_CAPABILITIES.includes(capability)))
  : value);

/** The phones ship on their own schedule, so a field this server does not know yet is stripped, not refused. */
export const phoneRegistration = z.object({
  installId: z.string().regex(/^[\w-]{8,64}$/),
  name: z.string().min(1).max(120),
  platform: z.enum(PHONE_PLATFORMS),
  appVersion: z.string().max(40),
  timeZone: z.string().max(64),
  /** Capability → the OS grant the phone holds ("full", "limited", "when_in_use", "send", "listener"); present means allowed. */
  capabilities: z.preprocess(knownCapabilities, z.partialRecord(z.enum(PHONE_CAPABILITIES), z.string().min(1).max(32))),
});
export type PhoneRegistration = z.infer<typeof phoneRegistration>;

const KEY = z.string().min(1).max(300);
const recordSchema = z.object({
  key: KEY, owner: z.string().min(1).max(300), registration: phoneRegistration,
  registeredAt: z.number(), seen: z.number(), lastUsedAt: z.number().nullable(),
}).strict();
/** The newest removals kept; an older one is forgotten, so that phone could register again under its old pairing. */
export const MAX_BLOCKED = 200;
/** `blocked`: keys the computer removed, absent from files written before it existed. */
const fileSchema = z.object({ version: z.literal(1), phones: z.array(recordSchema).max(200), blocked: z.array(KEY).max(MAX_BLOCKED).optional() });

export type PhoneRecord = { key: string; owner: string; registration: PhoneRegistration; registeredAt: number; seen: number; lastUsedAt: number | null };
/** What the owner's UI and the phone itself see. */
export type PublicPhone = Omit<PhoneRecord, "owner"> & { online: boolean; busy: boolean };

export const PHONE_ONLINE_MS = 60_000;
export const MAX_PHONES = 20;
export const PHONE_REMOVED_TEXT = "This phone was removed on the computer. Pair it again to use its apps.";
const SEEN_WRITE_MS = 60_000;

const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });

export class PhoneRegistry {
  private readonly file: string;
  private readonly now: () => number;
  private phones = new Map<string, PhoneRecord>();
  private written = new Map<string, number>();
  private removalPending = false;
  /** Removed on the computer: such a key never registers again; pairing the phone again gives it a new one. */
  private removed = new Set<string>();

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    try {
      if (existsSync(file)) {
        const saved = fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
        for (const phone of saved.phones) this.phones.set(phone.key, phone);
        this.removed = new Set(saved.blocked);
      }
    } catch {
      this.phones = new Map();
      this.removed = new Set();
      console.warn("phones: the record of paired phones could not be read; starting a new one");
    }
  }

  private save(required = false): void {
    try {
      writeFileAtomic(this.file, `${JSON.stringify({ version: 1, phones: [...this.phones.values()], blocked: [...this.removed] })}\n`, { mode: 0o600 });
      this.removalPending = false;
    } catch (error) {
      console.warn(`phones: could not save the record of paired phones: ${error instanceof Error ? error.message : String(error)}`);
      if (required) throw error;
    }
  }

  /** Same key: update. Same owner + installId under another key: replace that record, keeping its history. A key the
   * computer removed is refused with 403. */
  register(key: string, owner: string, registration: PhoneRegistration): PhoneRecord {
    if (this.removed.has(key)) throw failure(PHONE_REMOVED_TEXT, 403);
    const at = this.now();
    const sameKey = this.phones.get(key);
    const twin = [...this.phones.values()].find((phone) => phone.key !== key && phone.owner === owner && phone.registration.installId === registration.installId);
    const previous = sameKey ?? twin;
    if (!previous && this.phones.size >= MAX_PHONES) throw failure("Too many phones");
    if (twin) { this.phones.delete(twin.key); this.written.delete(twin.key); }
    const record: PhoneRecord = { key, owner, registration, registeredAt: previous?.registeredAt ?? at, seen: at, lastUsedAt: previous?.lastUsedAt ?? null };
    this.phones.set(key, record);
    this.written.set(key, at);
    this.save();
    return record;
  }

  get(key: string): PhoneRecord | undefined {
    return this.phones.get(key);
  }

  seen(key: string): void {
    const phone = this.phones.get(key);
    if (!phone) return;
    const at = this.now();
    phone.seen = at;
    if (at - (this.written.get(key) ?? 0) < SEEN_WRITE_MS) return;
    this.written.set(key, at);
    this.save();
  }

  used(key: string): void {
    const phone = this.phones.get(key);
    if (!phone) return;
    phone.lastUsedAt = phone.seen = this.now();
    this.save();
  }

  /** `block`: removed on the computer, so the key stays refused (persisted) until the phone pairs again; the phone
   * removing itself does not block. */
  remove(key: string, options: { block?: boolean } = {}): boolean {
    const removed = this.phones.delete(key);
    if (removed) this.written.delete(key);
    const blocking = options.block === true && !this.removed.has(key) && KEY.safeParse(key).success;
    if (blocking) {
      this.removed.add(key);
      for (const oldest of this.removed) { if (this.removed.size <= MAX_BLOCKED) break; this.removed.delete(oldest); }
    }
    if (removed || blocking) this.removalPending = true;
    if (this.removalPending) this.save(true);
    return removed;
  }

  blocked(key: string): boolean {
    return this.removed.has(key);
  }

  /** A null owner lists every phone (the desktop admin list). */
  list(owner: string | null, busy: (key: string) => boolean): PublicPhone[] {
    const at = this.now();
    return [...this.phones.values()]
      .filter((phone) => owner === null || phone.owner === owner)
      .sort((a, b) => b.seen - a.seen)
      .map(({ owner: _owner, ...rest }) => ({ ...rest, online: at - rest.seen < PHONE_ONLINE_MS, busy: busy(rest.key) }));
  }

  /** Seen within the last minute. */
  online(key: string): boolean {
    const phone = this.phones.get(key);
    return phone !== undefined && this.now() - phone.seen < PHONE_ONLINE_MS;
  }

  forOwner(owner: string): PhoneRecord[] {
    return [...this.phones.values()].filter((phone) => phone.owner === owner);
  }
}
