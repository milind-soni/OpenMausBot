import { Brain } from "lucide-react";

import { memoryUpkeepEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import type { Bot } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { Card, SwitchRow } from "./rows";

/** This bot's automatic memory, which Advanced calls Memory upkeep. Settings → Features turns it off for every bot. */
export function MemoryUpkeepRow({ bot, onChange }: { bot: Bot; onChange: (memoryUpkeep: boolean) => void }) {
  const dispatch = useStoreDispatch();
  const allBots = useStoreSelector((state) => memoryUpkeepEnabled(state.config));
  const team = useStoreSelector((state) => Boolean(state.config?.team));
  const admin = useOwnerOrAdmin() === true;
  const canChangeAll = !team || admin;
  if (bot.memoryEnabled === false) return null;
  const on = bot.memoryUpkeep !== false;
  const hint = allBots ? t("botPanel.memoryUpkeep.hint") : (
    <>
      {t("botPanel.memoryUpkeep.offForAll")}
      {canChangeAll && (
        <>
          {" "}
          <button
            type="button"
            data-panel-action="memory-upkeep-features"
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "features" })}
            className="font-medium text-ink underline underline-offset-2 hover:no-underline"
          >
            {t("botPanel.memoryUpkeep.openFeatures")}
          </button>
        </>
      )}
    </>
  );
  return (
    <Card anchor="memory">
      <SwitchRow
        data-panel-row="memory-upkeep"
        icon={Brain}
        title={t("botPanel.memoryUpkeep.title")}
        hint={hint}
        color={bot.color}
        checked={allBots && on}
        disabled={!allBots}
        onChange={() => onChange(!on)}
      />
    </Card>
  );
}
