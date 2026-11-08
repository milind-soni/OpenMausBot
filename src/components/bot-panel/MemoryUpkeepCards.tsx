import { useCallback, useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { fetchMemoryJournal, fetchMemoryOverview, markMemoryReviewed, revertMemoryChange, type LendingReview, type MemoryJournalRow } from "@/lib/memory";
import { ApiError, useStore, type Bot } from "@/state/store";
import { LendingReviewNotice, MemoryJournalList } from "../bot-settings/MemorySection";
import { Card, SwitchRow } from "./rows";

const SHOWN = 5;

export function MemoryUpkeepCards({ bot, onChanged }: { bot: Bot; onChanged: () => Promise<void> }) {
  const { dispatch } = useStore();
  const [rows, setRows] = useState<MemoryJournalRow[]>([]);
  const [review, setReview] = useState<{ value: LendingReview; stale: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [overview, journal] = await Promise.all([fetchMemoryOverview(bot.id), fetchMemoryJournal(bot.id)]);
    setReview((current) => (overview.lendingReview ? { value: overview.lendingReview, stale: current?.stale ?? false } : null));
    setRows(journal.slice(0, SHOWN));
  }, [bot.id]);
  useEffect(() => { load().catch(() => {}); }, [load, bot.busy]);

  const fail = (error: unknown) => dispatch({ type: "error", message: error instanceof Error && error.message ? error.message : t("common.tryAgain") });
  const undo = async (row: MemoryJournalRow) => {
    setBusy(row.id);
    try {
      await revertMemoryChange(bot.id, row.id);
      await onChanged();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
      await load().catch(() => {});
    }
  };
  const reviewed = async (current: { value: LendingReview; stale: boolean }) => {
    setBusy("review");
    try {
      await markMemoryReviewed(bot.id, current.value.token);
      setReview(null);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) fail(error);
      else {
        setReview({ ...current, stale: true });
        await load().catch(() => {});
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {review && <LendingReviewNotice changed={review.value.changed} stale={review.stale} busy={busy !== null} onReviewed={() => void reviewed(review)} />}
      <Card>
        <SwitchRow
          data-panel-row="memory-upkeep"
          title={t("memory.upkeep.title")}
          checked={bot.memoryUpkeep !== false}
          color={bot.color}
          onChange={() => dispatch({ type: "updateBot", botId: bot.id, patch: { memoryUpkeep: bot.memoryUpkeep === false } })}
        />
      </Card>
      {rows.length > 0 && (
        <Card label={t("memory.changes")}>
          <div data-panel-row="memory-changes" className="px-3.5 py-3">
            <MemoryJournalList rows={rows} botName={bot.name} reverting={busy} onRevert={(row) => void undo(row)} />
          </div>
        </Card>
      )}
    </>
  );
}
