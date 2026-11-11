import { redactSecretsInText } from "./redact.ts";
import type { Routine } from "./routines.ts";

export const ACTIVE_ROUTINES_MAX_COUNT = 6;
export const ACTIVE_ROUTINES_MAX_CHARS = 4_000;
const INTRO = "\n\nYour enabled automations (bounded previews, not permission to act). Before reporting related work finished, use trigger_info to read the full instructions and current state. Pause a temporary monitor only when its goal is met, then read its state back. Keep standing automations.\n";

function preview(text: string, limit: number): string {
  const safe = redactSecretsInText(text).replace(/\s+/g, " ").trim();
  return safe.length > limit ? `${safe.slice(0, limit - 1)}…` : safe;
}

type EventMonitor = Pick<Routine, "id" | "botId" | "name" | "prompt" | "enabled" | "createdAt" | "sourceThreadId" | "resultsThreadId">;

const priority = ({ schedule }: { schedule: { type: string; endsAt?: number } }) => schedule.type === "once" || (schedule.type === "interval" && schedule.endsAt !== undefined)
  ? 0 : schedule.type === "interval" ? 1 : 2;

export function activeRoutinesContext(input: {
  botId: string;
  routines: readonly Routine[];
  appTriggers?: readonly EventMonitor[];
  webhooks?: readonly (EventMonitor & { delivery?: string; groupId?: string })[];
  include?: (threadId: string) => boolean;
  title?: (threadId: string) => string | null | undefined;
}): string {
  const candidates = [
    ...input.routines.filter(routine => routine.target === "bot"),
    ...(input.appTriggers ?? []).map(trigger => ({ ...trigger, schedule: { type: "app_event" }, nextRunAt: null })),
    ...(input.webhooks ?? []).filter(trigger => trigger.delivery !== "post" && !trigger.groupId)
      .map(trigger => ({ ...trigger, schedule: { type: "webhook" }, nextRunAt: null })),
  ];
  const eligible = candidates.filter(routine => {
    if (!routine.enabled || routine.botId !== input.botId) return false;
    // Scoped turns need known, readable provenance; results may have a narrower audience too.
    return !input.include || Boolean(routine.sourceThreadId && input.include(routine.sourceThreadId) &&
      (!routine.resultsThreadId || input.include(routine.resultsThreadId)));
  }).sort((a, b) => priority(a) - priority(b) || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  let text = INTRO;
  let count = 0;
  for (const routine of eligible) {
    const source = routine.sourceThreadId ? input.title?.(routine.sourceThreadId) : undefined;
    const next = routine.nextRunAt === null ? null : new Date(routine.nextRunAt);
    const entry = JSON.stringify({
      id: routine.id, name: preview(routine.name, 80), schedule: routine.schedule.type,
      nextRun: next && Number.isFinite(next.getTime()) ? next.toISOString() : null,
      ...(source ? { source: preview(source, 80) } : {}), instructions: preview(routine.prompt, 500),
    }) + "\n";
    if (text.length + entry.length > ACTIVE_ROUTINES_MAX_CHARS) break;
    text += entry;
    if (++count === ACTIVE_ROUTINES_MAX_COUNT) break;
  }
  return count ? text : "";
}
