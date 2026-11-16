// The one setting that fixes a failed turn, on its row: the bot's model picker when its AI is out of credits, limited,
// overloaded or cannot run the model, and Spending when the workspace reached its spend limit. Sign-in has its own
// control on the row already (EngineSetup).
import type { ReactNode } from "react";

import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { settingFix } from "../../shared/setting-fixes";
import { ModelPicker } from "./ModelPicker";

export type FailedTurnAction = { label: string; onClick: () => void };

/** What the row offers besides Retry: `action` takes Retry's place, `control` sits below it. */
export function useFailedTurnFix(tool: NonNullable<Message["tool"]>, botId: string | undefined, threadId: string | undefined): { action?: FailedTurnAction; control?: ReactNode } {
  const dispatch = useStoreDispatch();
  const bot = useStoreSelector((state) => (botId ? state.bots.find((candidate) => candidate.id === botId) : undefined));
  const fix = settingFix(tool);
  if (fix === "spend-limit") return { action: { label: t("chat.error.openSpending"), onClick: () => dispatch({ type: "toggleAppSettings", open: true, section: "usage" }) } };
  if (fix === "model" && bot) {
    return { control: <div data-failed-turn-fix="model" className="mt-1.5"><ModelPicker bot={bot} threadId={threadId} contained size="sm" label={<span className="text-[13px] text-ink-secondary">{t("chat.error.switchModel")}</span>} /></div> };
  }
  return {};
}
