// Who a usage row was spent for, and in which department. A routine's row names the person who wrote the routine (on a
// Team Cloud), and work a teammate did for a delegating turn names the person whose turn started the job, followed
// down the trace's parent links; the department is the bot's when the row is booked, so moving a bot later never
// rewrites what was spent.
import type { UsageRow } from "./usage-ledger.ts";

const REMEMBERED_TURNS = 5_000;

export interface UsageAttributionDeps {
  /** The bot's department now; blank or missing is none. */
  section(botId: string): string | undefined;
  /** The email of the person who wrote the routine, when known. */
  routineWriter(routineId: string): string | undefined;
  /** What started the conversation's current turn: a parent still running has no row yet. */
  threadTrigger?(threadId: string): UsageRow["trigger"] | undefined;
}

export function createUsageAttribution(deps: UsageAttributionDeps) {
  const turnPerson = new Map<string, string>();
  const remember = (turnId: string | undefined, email: string | undefined) => {
    if (!turnId || !email) return;
    turnPerson.delete(turnId);
    turnPerson.set(turnId, email);
    if (turnPerson.size > REMEMBERED_TURNS) turnPerson.delete(turnPerson.keys().next().value!);
  };
  return <Row extends Pick<UsageRow, "botId" | "trigger" | "turnId" | "parent">>(row: Row): Row & Pick<UsageRow, "section"> => {
    const section = deps.section(row.botId)?.trim();
    let trigger = row.trigger;
    if (trigger.kind === "routine" && !trigger.email && trigger.routineId) {
      const email = deps.routineWriter(trigger.routineId);
      if (email) trigger = { ...trigger, email };
    } else if (trigger.kind !== "user" && trigger.kind !== "routine" && !trigger.email && row.parent) {
      // A teammate can finish before the turn that delegated to it is booked.
      const parentTrigger = deps.threadTrigger?.(row.parent.threadId);
      const email = turnPerson.get(row.parent.turnId) ?? (parentTrigger ? personOf(parentTrigger) : undefined);
      if (email) trigger = { ...trigger, email };
    }
    remember(row.turnId, personOf(trigger));
    return { ...row, trigger, ...(section ? { section } : {}) };
  };
}

/** The person a row was spent for, if any. */
export function personOf(trigger: UsageRow["trigger"]): string | undefined {
  return trigger.email;
}
