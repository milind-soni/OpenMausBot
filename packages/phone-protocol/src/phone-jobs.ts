// What a paired phone and its server exchange when the phone's own apps are bot tools: the phone registers
// (PUT /api/phones/self), takes jobs (GET /api/phones/self/jobs) and answers each one.
import { z } from "zod";

import { PHONE_CAPABILITIES, PHONE_PLATFORMS } from "./phone-apps.ts";

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

export const PHONE_JOB_CODES = ["denied", "foreground_required", "not_found", "too_large", "unsupported", "offline", "timeout", "turn_ended"] as const;
export type PhoneJobCode = (typeof PHONE_JOB_CODES)[number];
export type PhoneJobOutcome = { ok: true; result: unknown } | { ok: false; error: string; code?: PhoneJobCode };
const KNOWN_CODES: readonly unknown[] = PHONE_JOB_CODES;
/** A newer phone's extra field is stripped, and a code this server does not know yet reads as none: the error still
 * reaches the bot. */
export const phoneJobOutcome = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string().max(2000), code: z.preprocess((code) => (KNOWN_CODES.includes(code) ? code : undefined), z.enum(PHONE_JOB_CODES).optional()) }),
]);

/** One job as GET /api/phones/self/jobs hands it to the phone. */
export type PhoneJobDelivery = { id: string; tool: string; arguments: Record<string, unknown>; expiresAt: number };
