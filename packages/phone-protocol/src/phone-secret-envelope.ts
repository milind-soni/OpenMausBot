// The credential a paired phone seals for one secure credential card, sent as
// POST /api/bots/<bot>/secret-cards/<message>/provide. The value inside is HPKE-sealed to this server's key; the
// server refuses any other version.
import { z } from "zod";

export const PHONE_SECRET_PROTOCOL_VERSION = 1 as const;
export const PHONE_SECRET_INFO = "OpenMausBot phone credential v1";
export const PHONE_SECRET_MAX_BYTES = 4_096;

export const phoneSecretEnvelopeSchema = z.object({
  version: z.literal(PHONE_SECRET_PROTOCOL_VERSION),
  threadId: z.string().regex(/^[\w-]{1,128}$/),
  keyId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  deviceId: z.string().regex(/^[\w-]{1,128}$/),
  target: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
  requestKey: z.string().regex(/^[\w-]{1,128}$/),
  encapsulatedKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{23,5483}$/),
}).strict();
