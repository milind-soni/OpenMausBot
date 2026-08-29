import { z } from "zod";
import type { JsonValue } from "../../server/schema";

export const agentProfileSummarySchema = z.object({
  generatedAt: z.number().finite(),
  identityAndPreferences: z.number().int().nonnegative(),
  standingRules: z.number().int().nonnegative(),
  openWork: z.number().int().nonnegative(),
  accountBindings: z.number().int().nonnegative(),
  lastUpdatedAt: z.number().finite().nullable(),
});

export type AgentProfileSummary = z.infer<typeof agentProfileSummarySchema>;

export function parseAgentProfileSummary(value: JsonValue): AgentProfileSummary | null {
  const parsed = agentProfileSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function relativeProfileFreshness(lastUpdatedAt: number | null, now = Date.now()): string {
  if (lastUpdatedAt === null) return "Not populated yet";
  const minutes = Math.max(0, Math.floor((now - lastUpdatedAt) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}
