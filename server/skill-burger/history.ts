// Each saved Skill Burger's recent runs, so its card can say how the last ones went: when, in which chat, which step
// stopped a failed one, which saved values a run reused. One small JSON file; at most RUNS_KEPT runs a burger and
// NAMES_KEPT burgers, newest first. A run that pauses (for the bot, for teammates) is updated in place as it goes on.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { RUN_STATE_TTL_MS } from "./run-state.ts";
import type { RunEnvelope } from "./runner.ts";

export const RUNS_KEPT = 12;
const NAMES_KEPT = 200;

export interface RunRecord {
  run: string;
  name: string;
  botId: string;
  threadId: string;
  startedAt: number;
  at: number;
  status: "ok" | "failed" | "waiting" | "cancelled";
  steps: Array<{ id: string; label: string; state: string }>;
  /** The step a failed run stopped at, and why. */
  failed?: { step: string; label: string; error: string };
  /** Inputs the request didn't give, so the run used the saved values. */
  defaults?: string[];
  /** A later run of the same burger in that chat went on from the failed step and finished. */
  fixedBy?: string;
}

type Ledger = Record<string, RunRecord[]>;

export function createRunHistory(dir: string, now: () => number = Date.now) {
  const file = join(dir, "history.json");
  const read = (): Ledger => {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Ledger : {};
    } catch {
      return {};
    }
  };
  const write = (ledger: Ledger) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const names = Object.entries(ledger).sort(([, a], [, b]) => (b[0]?.at ?? 0) - (a[0]?.at ?? 0)).slice(0, NAMES_KEPT);
    writeFileAtomic(file, JSON.stringify(Object.fromEntries(names)), { mode: 0o600 });
  };
  return {
    /** Notes where the run `envelope` stands. */
    record(context: { name: string; botId: string; threadId: string }, envelope: RunEnvelope): void {
      try {
        const ledger = read();
        const runs = ledger[context.name] ?? [];
        const at = runs.findIndex((one) => one.run === envelope.run);
        const before = at >= 0 ? runs[at]! : undefined;
        const steps = envelope.steps.length ? envelope.steps.map((step) => ({ id: step.id, label: step.label, state: step.state })) : before?.steps ?? [];
        const failedStep = envelope.error?.step ? steps.find((step) => step.id === envelope.error!.step) : undefined;
        const status: RunRecord["status"] = envelope.error ? "failed" : envelope.status === "needs_input" ? "waiting" : envelope.status === "cancelled" ? "cancelled" : "ok";
        const record: RunRecord = {
          run: envelope.run, name: context.name, botId: context.botId, threadId: context.threadId, startedAt: before?.startedAt ?? now(), at: now(), status, steps,
          ...(envelope.error ? { failed: { step: envelope.error.step ?? "", label: failedStep?.label ?? "", error: envelope.error.message.slice(0, 300) } } : {}),
          ...(envelope.defaults?.length ? { defaults: envelope.defaults.map((one) => one.name) } : before?.defaults ? { defaults: before.defaults } : {}),
          ...(before?.fixedBy ? { fixedBy: before.fixedBy } : {}),
        };
        // A run that went on from its failed step, and that step then worked, was fixed in its chat: the card can offer to
        // keep the fix, whether or not the run has finished since.
        const failedBefore = before?.failed?.step;
        if (failedBefore && steps.find((step) => step.id === failedBefore)?.state === "done") record.fixedBy = failedBefore;
        ledger[context.name] = [record, ...runs.filter((one) => one.run !== envelope.run)].slice(0, RUNS_KEPT);
        write(ledger);
      } catch {
        // A run never fails because its history couldn't be written.
      }
    },
    /** The burger's recent runs, newest first, by the bots in `botIds` (every bot when absent). */
    list(name: string, botIds?: ReadonlySet<string>): RunRecord[] {
      // A run still waiting after its pause can no longer be resumed (a day) never finished: it shows as stopped.
      return (read()[name] ?? []).filter((one) => !botIds || botIds.has(one.botId))
        .map((one) => (one.status === "waiting" && now() - one.at > RUN_STATE_TTL_MS ? { ...one, status: "cancelled" as const } : one));
    },
  };
}
export type RunHistory = ReturnType<typeof createRunHistory>;
