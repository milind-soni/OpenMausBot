import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { api, useStore, type Bot } from "@/state/store";
import type { BotOverview } from "@/lib/bot-overview-types";
import { ConfirmDialog } from "../ConfirmDialog";
import type { HistoryRow } from "./HistorySection";
import type { PromptPreviewData } from "./PromptPreview";

/**
 * Reads the bot's overview and prompt preview while `want` asks for them. By default every change to the bot's facts
 * reads them again. `followEdits: false` reads only when `want` changes: the Simple bot panel edits those facts inline
 * (its Instructions field patches on every keystroke), and a read first flushes the patch queue, so following edits
 * there would save, record a history row and read once per keystroke.
 */
export function useBotOverview(bot: Bot, want: { overview: boolean; prompt: boolean; followEdits?: boolean }) {
  const { state, flushBotPatches } = useStore();
  const [overview, setOverview] = useState<BotOverview | null>(null);
  const [overviewError, setOverviewError] = useState(false);
  const [prompt, setPrompt] = useState<PromptPreviewData | null>(null);
  const [promptError, setPromptError] = useState(false);

  const factsSignature = useMemo(
    () =>
      JSON.stringify([
        bot.name,
        bot.title,
        bot.description,
        bot.soul,
        bot.computer,
        bot.cloudBackend,
        bot.cwd,
        bot.autoApprove,
        bot.approvePeerComms,
        bot.peers,
        bot.section,
        bot.composio,
        bot.browser,
        bot.mcpServers,
        bot.chiefOfStaff,
        bot.managedSections,
        bot.modelSelection,
      ]),
    [
      bot.name,
      bot.title,
      bot.description,
      bot.soul,
      bot.computer,
      bot.cloudBackend,
      bot.cwd,
      bot.autoApprove,
      bot.approvePeerComms,
      bot.peers,
      bot.section,
      bot.composio,
      bot.browser,
      bot.mcpServers,
      bot.chiefOfStaff,
      bot.managedSections,
      bot.modelSelection,
    ],
  );

  const followEdits = want.followEdits ?? true;
  const editedFacts = followEdits ? factsSignature : null;
  const routines = followEdits ? state.routines : null;
  const webhooks = followEdits ? state.webhooks : null;

  // Await the existing write queue rather than racing a second debounce.
  useEffect(() => {
    if (!want.overview && !want.prompt) return;
    let cancelled = false;
    const fetchOverviewAndPrompt = async () => {
      await flushBotPatches(bot.id);
      if (cancelled) return;
      if (want.overview) {
        void api(`/api/bots/${bot.id}/overview`)
          .then((data: BotOverview) => {
            if (cancelled) return;
            setOverview(data);
            setOverviewError(false);
          })
          .catch(() => {
            if (!cancelled) setOverviewError(true);
          });
      }
      if (want.prompt) {
        void api(`/api/bots/${bot.id}/system-prompt`)
          .then((data: PromptPreviewData) => {
            if (cancelled) return;
            setPrompt(data);
            setPromptError(false);
          })
          .catch(() => {
            if (!cancelled) setPromptError(true);
          });
      }
    };

    void fetchOverviewAndPrompt();
    return () => {
      cancelled = true;
    };
  }, [bot.id, want.overview, want.prompt, editedFacts, routines, webhooks, flushBotPatches]);

  return { overview, overviewError, prompt, promptError };
}

export function useBotHistory(bot: Bot, active: boolean) {
  const { dispatch, flushBotPatches } = useStore();
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState<string | null>(null);
  const request = useRef(0);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<{ id: string; expectedRevision: string } | null>(null);

  const load = useCallback(() => {
    const current = ++request.current;
    setError(false);
    return flushBotPatches(bot.id)
      .then(() => api(`/api/bots/${bot.id}/history?limit=100`))
      .then((data: { rows: HistoryRow[]; revision: string }) => {
        if (current !== request.current) return;
        setRows(data.rows);
        setRevision(data.revision);
      })
      .catch(() => {
        if (current === request.current) setError(true);
      });
  }, [bot.id, flushBotPatches]);

  useEffect(() => {
    if (!active) return;
    void load();
    return () => { request.current++; };
  }, [active, load]);

  const rollback = async (target: { id: string; expectedRevision: string }) => {
    if (rollingBack) return;
    setRollbackTarget(null);
    setRollingBack(true);
    try {
      await flushBotPatches(bot.id);
      await api(`/api/bots/${bot.id}/history/rollback`, {
        method: "POST",
        body: JSON.stringify(target),
      });
    } catch (e: unknown) {
      dispatch({ type: "error", message: e instanceof Error ? e.message : "Couldn't undo that change." });
    } finally {
      await load();
      setRollingBack(false);
    }
  };

  const requestRollback = (id: string) => {
    if (revision) setRollbackTarget({ id, expectedRevision: revision });
  };

  return { rows, error, revision, rollingBack, rollbackTarget, setRollbackTarget, rollback, requestRollback };
}

export function HistoryRollbackDialog({ history, returnFocusRef }: {
  history: ReturnType<typeof useBotHistory>;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { rollbackTarget, setRollbackTarget, rollback } = history;
  return (
    <ConfirmDialog
      open={rollbackTarget !== null}
      title="Restore previous instructions?"
      body="Replaces current SOUL with the version before this change. Current version stays in History."
      confirmLabel="Restore instructions"
      tone="neutral"
      returnFocusRef={returnFocusRef}
      onCancel={() => setRollbackTarget(null)}
      onConfirm={() => { if (rollbackTarget) void rollback(rollbackTarget); }}
    />
  );
}
