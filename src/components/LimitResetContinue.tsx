import { useState } from "react";
import { Hourglass } from "lucide-react";

import { t } from "@/lib/i18n";
import { limitLine, loadLimits, nearLimit, resetTime, useEngineLimits } from "@/lib/limit-resets";
import type { Routine } from "@/lib/routines";
import { api, useStore } from "@/state/store";

/** The stopped turn's "Continue at 3:40 PM when your limit resets": one click sets up a one-time automation in this
 * conversation that picks up where it stopped. Undefined when there is nothing to offer. */
export function useLimitResetContinue(botId: string | undefined, threadId: string | undefined, resetsAt: number | undefined) {
  const { dispatch } = useStore();
  const [state, setState] = useState<"idle" | "working" | "set">("idle");
  if (!botId || !threadId || !resetsAt || resetsAt <= Date.now() || state === "set") return undefined;
  return {
    label: t("chat.limit.continueAt", { time: resetTime(resetsAt) }),
    onClick: () => {
      if (state === "working") return;
      setState("working");
      void api<{ routine?: Routine }>("/api/limit-resets/continue", { method: "POST", body: JSON.stringify({ botId, threadId }) })
        .then((response) => {
          if (response.routine) dispatch({ type: "routinePatched", routine: response.routine });
          setState("set");
        })
        .catch((cause) => {
          setState("idle");
          dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) });
        });
    },
  };
}

/** A compact line in the bot's chat when its engine is nearly out of usage: "Claude: 92% used · resets 3:40 PM".
 * Clicking it checks the engine's usage again. */
export function EngineLimitNotice({ engine }: { engine: string | undefined }) {
  const limit = useEngineLimits().find((candidate) => candidate.engine === engine);
  const [checking, setChecking] = useState(false);
  if (!limit || !nearLimit(limit)) return null;
  const hint = limit.blocked ? t("limits.blockedHint", { engine: limit.name }) : t("limits.chatHint");
  return (
    <button type="button" data-testid="engine-limit-notice" title={hint} aria-label={`${limitLine(limit)}. ${hint}`}
      disabled={checking} onClick={() => { setChecking(true); void loadLimits(true).finally(() => setChecking(false)); }}
      className="flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-[13px] text-ink hover:bg-warning/15 disabled:cursor-wait">
      <Hourglass size={13} className={checking ? "shrink-0 animate-pulse text-warning" : "shrink-0 text-warning"} aria-hidden="true" />
      <span className="tabular-nums">{limitLine(limit)}</span>
    </button>
  );
}
