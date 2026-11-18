import { useCallback, useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { fetchSoulChanges, undoSoulChange, type MemoryJournalRow } from "@/lib/memory";
import { useStore, type Bot } from "@/state/store";
import { MemoryJournalList } from "../bot-settings/MemorySection";

const SHOWN = 5;

export function SoulChanges({ bot }: { bot: Bot }) {
  const { dispatch, flushBotPatches } = useStore();
  const [rows, setRows] = useState<MemoryJournalRow[]>([]);
  const [reverting, setReverting] = useState<string | null>(null);
  const load = useCallback(() => fetchSoulChanges(bot.id).then((list) => setRows(list.rows.slice(0, SHOWN)), () => {}), [bot.id]);
  useEffect(() => { void load(); }, [load, bot.soul]);
  if (!rows.length) return null;

  const undo = async (row: MemoryJournalRow) => {
    if (reverting) return;
    setReverting(row.id);
    try {
      await flushBotPatches(bot.id);
      const { revision } = await fetchSoulChanges(bot.id);
      await undoSoulChange(bot.id, row.id, revision);
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error && error.message ? error.message : t("botOverview.undoFailed") });
    } finally {
      setReverting(null);
      await load();
    }
  };
  return (
    <div data-panel-row="soul-changes" className="flex flex-col gap-1.5">
      <div className="text-[12px] font-medium text-ink-secondary">{t("memory.changes")}</div>
      <MemoryJournalList rows={rows} botName={bot.name} reverting={reverting} onRevert={(row) => void undo(row)} />
    </div>
  );
}
