// What the records an admin reads may say on a Team Cloud (docs/team-cloud.md "Team admin"): usage, the decision log
// and admin activity. Admins read how much each person used, by person and team bot, and when a bot decided something;
// never on what, in which conversation, or anything of a person's own MausBot. Off a team every row is read as it is.
import type { AdminActionRow } from "../admin-activity.ts";
import { routineVisible, type RoutineRef, type VisibleSet } from "../bot-visibility.ts";
import type { DecisionRow } from "../decision-log.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PRIVATE_ROUTINE, type UsageRow } from "../usage-ledger.ts";

/** A person's own MausBot, to anyone else. */
export const PRIVATE_BOT = { botId: "private", botName: "Private bot" } as const;

export interface PrivateRecordsDeps {
  visibleFor(auth: RequestAuth): VisibleSet;
  botExists(botId: string): boolean;
  routine(routineId: string): RoutineRef | undefined;
}

export function createPrivateRecords(deps: PrivateRecordsDeps) {
  /** A bot that is someone else's alone; one since deleted counts when its conversation was theirs. */
  const hidesBot = (visible: VisibleSet, botId: string | undefined, hiddenThread: boolean): boolean =>
    botId !== undefined && (deps.botExists(botId) ? !visible.bot(botId) : hiddenThread);
  return {
    /** Security invariant: a row from someone else's private conversation, private routine or own MausBot keeps its
     * amounts, time, model and person, and loses everything that says what it was: the conversation's id, the routine's
     * name and id, the bot when it is theirs alone. */
    usageRow(auth: RequestAuth) {
      const visible = deps.visibleFor(auth);
      return (row: UsageRow): UsageRow => {
        if (!visible.filtersThreads) return row;
        const hiddenThread = visible.hides(row.threadId);
        const hiddenBot = hidesBot(visible, row.botId, hiddenThread);
        const routine = row.trigger.kind === "routine" && row.trigger.routineId ? deps.routine(row.trigger.routineId) : undefined;
        const hiddenRoutine = row.trigger.kind === "routine" && (hiddenThread || hiddenBot || Boolean(routine && !routineVisible(routine, visible)));
        if (!hiddenThread && !hiddenBot && !hiddenRoutine) return row;
        const { turnId: _turnId, parent: _parent, section, ...kept } = row;
        const person = row.trigger.email ? { email: row.trigger.email } : {};
        return {
          ...kept,
          threadId: "",
          ...(hiddenBot ? PRIVATE_BOT : section === undefined ? {} : { section }),
          trigger: hiddenRoutine ? { kind: "routine", ...PRIVATE_ROUTINE, ...person }
            : row.trigger.kind === "bot" || row.trigger.kind === "helper" ? { kind: row.trigger.kind, ...person } : row.trigger,
        };
      };
    },
    /** Security invariant: a decision in a conversation the reader may not see keeps its when, which team bot, which
     * tool and what was decided; never its words, where, or a bot that is someone else's alone. */
    decisionRow(auth: RequestAuth) {
      const visible = deps.visibleFor(auth);
      return (row: DecisionRow): DecisionRow => {
        if (!visible.hides(row.threadId)) return row;
        const { summary: _summary, summaryCode: _code, summaryParams: _params, rule: _rule, requestId: _requestId, ...kept } = row;
        return { ...kept, threadId: "", ...(visible.filtersThreads && hidesBot(visible, row.botId, true) ? PRIVATE_BOT : {}) };
      };
    },
    /** Security invariant: an admin action on a bot the reader may not see is not theirs to read. */
    adminActionShown(auth: RequestAuth) {
      const visible = deps.visibleFor(auth);
      return (row: AdminActionRow): boolean => !visible.filtersThreads || row.target?.kind !== "bot" || !row.target.id || !hidesBot(visible, row.target.id, false);
    },
  };
}

export type PrivateRecords = ReturnType<typeof createPrivateRecords>;
