// The shape of `usageCaps` in config.json, apart from the engine that reads the ledger (usage-caps.ts).
import { z } from "zod";

const amount = z.number().finite().min(0).max(1_000_000);
const tokens = z.number().int().min(0).max(1_000_000_000_000);
const limitsSchema = z.object({
  dailyUsd: amount.optional(),
  monthlyUsd: amount.optional(),
  dailyTokens: tokens.optional(),
  monthlyTokens: tokens.optional(),
}).strict();

/** `config.json` → `usageCaps`. Every cap is optional and none is set by default; 0 or absent means no cap. Days and
 * months are UTC, as the usage ledger's are. Dollars are the ledger's estimate (notional on a subscription sign-in, 0
 * for a model with no price), so a token cap is the one that always counts. */
export const usageCapsSchema = z.object({
  /** What a reached cap stops: `unattended` (the default) stops routines, webhooks, app events, Bot API calls and
   * hand-offs nobody is waiting on, and a person's own message still runs; `everything` stops a person's messages too. */
  stops: z.enum(["unattended", "everything"]).optional(),
  /** Caps on everything this server's bots use together. */
  server: limitsSchema.optional(),
  /** Caps on one bot, by bot id. */
  bots: z.record(z.string().min(1).max(128), limitsSchema).optional(),
}).strict();

export type CapLimits = z.output<typeof limitsSchema>;
export type UsageCapsConfig = z.output<typeof usageCapsSchema>;
