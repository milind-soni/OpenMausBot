import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";

import { t } from "@/lib/i18n";
import { tidyMemoryNow } from "@/lib/memory";
import { api, useStore, type Bot } from "@/state/store";
import { buttonCls, Card, RowIcon, rowCls, RowText } from "./rows";

export function HeavyBotRow({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [heavy, setHeavy] = useState(false);
  const [tidying, setTidying] = useState(false);
  const [checked, setChecked] = useState(0);
  const upkeep = bot.memoryEnabled !== false && bot.memoryUpkeep !== false;
  useEffect(() => {
    if (!upkeep) return;
    let live = true;
    api<{ heavy?: boolean }>(`/api/bots/${bot.id}/system-prompt`).then((preview) => { if (live) setHeavy(preview.heavy === true); }, () => {});
    return () => { live = false; };
  }, [bot.id, upkeep, checked]);
  if (!upkeep || !heavy) return null;

  const tidy = async () => {
    setTidying(true);
    try {
      await tidyMemoryNow(bot.id);
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error && error.message ? error.message : t("common.tryAgain") });
    } finally {
      setTidying(false);
      setChecked((n) => n + 1);
    }
  };
  return (
    <Card anchor="heavy">
      <div data-panel-row="heavy" className={rowCls}>
        <RowIcon icon={Gauge} />
        <RowText title={t("botPanel.heavy")} />
        <button type="button" data-panel-action="tidy-memory" disabled={tidying} onClick={() => void tidy()} className={buttonCls}>
          {tidying ? t("memory.upkeep.tidying") : t("botPanel.tidyMemory")}
        </button>
      </div>
    </Card>
  );
}
