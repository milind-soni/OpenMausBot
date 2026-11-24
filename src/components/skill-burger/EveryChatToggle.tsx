import { useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { setBurgerEveryChat, type SavedWorkflow } from "@/lib/skill-burger";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { Switch } from "../SettingsPrimitives";

/** A Skill Burger's one choice: this bot only, or every chat. Changing what every bot uses is an admin's, as the shared
 * skills library is; anyone else sees the switch with the reason it is off. */
export function EveryChatToggle({ skill, onMoved, compact = false, className }: {
  skill: SavedWorkflow;
  onMoved?: (skill: SavedWorkflow) => void;
  compact?: boolean;
  className?: string;
}) {
  const admin = useOwnerOrAdmin() !== false;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const flip = async () => {
    if (busy) return;
    setBusy(true);
    setProblem("");
    try {
      onMoved?.(await setBurgerEveryChat(skill, !skill.everyChat));
    } catch (cause) {
      setProblem(cause instanceof Error && cause.message ? cause.message : t("skillBurger.everyChatFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <label className={cn("flex min-w-0 items-center gap-2 text-ink-secondary", compact ? "text-[12px]" : "text-[13px]")} title={admin ? undefined : t("settings.adminOnly.change")}>
        <Switch
          compact={compact}
          checked={skill.everyChat}
          disabled={!admin || busy}
          aria-label={t("skillBurger.everyChat")}
          onClick={() => void flip()}
          data-every-chat={skill.everyChat ? "on" : "off"}
        />
        <span className="min-w-0 truncate">{t("skillBurger.everyChat")}</span>
      </label>
      {!admin && !compact && <span className="mt-0.5 text-[12px] text-ink-tertiary">{t("settings.adminOnly.change")}</span>}
      {problem && <span role="alert" className="mt-0.5 text-[12px] text-danger">{problem}</span>}
    </div>
  );
}
