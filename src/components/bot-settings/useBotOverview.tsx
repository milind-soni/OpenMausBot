import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { api, type Bot } from "@/state/store";
import type { BotOverview } from "@/lib/bot-overview-types";
import { ConfirmDialog } from "../ConfirmDialog";
import type { HistoryRow } from "./HistorySection";
import type { PromptPreviewData } from "./PromptPreview";
import { t } from "@/lib/i18n";
import { sameFields, useStoreActions, useStoreDispatch, useStoreSelector } from "@/state/store-select";

/**
 * Reads the bot's overview and prompt preview while `want` asks for them. By default every change to the bot's facts
 * reads them again. `followEdits: false` reads only when `want` changes: the Simple bot panel edits those facts inline
 * (its Instructions field patches on every keystroke), and a read first flushes the patch queue, so following edits
 * there would save, record a history row and read once per keystroke.
 */
type OverviewSnapshot = {
  botId: string;
  overview: BotOverview | null;
  overviewError: boolean;
  prompt: PromptPreviewData | null;
  promptError: boolean;
};
const emptyOverview = (botId: string): OverviewSnapshot => ({ botId, overview: null, overviewError: false, prompt: null, promptError: false });

export function useBotOverview(bot: Bot, want: { overview: boolean; prompt: boolean; followEdits?: boolean }) {
  const state = useStoreSelector((s) => ({ routines: s.routines, webhooks: s.webhooks }), sameFields), { flushBotPatches } = useStoreActions();
  // What was read belongs to the bot it was read for: on the first render after a switch the previous bot's overview or
  // prompt must not show under the new bot, so anything read for another bot is treated as empty.
  const [snapshot, setSnapshot] = useState<OverviewSnapshot>(() => emptyOverview(bot.id));
  const view = snapshot.botId === bot.id ? snapshot : emptyOverview(bot.id);
  const { overview, overviewError, prompt, promptError } = view;
  const ownerId = useRef(bot.id);

  useEffect(() => {
    ownerId.current = bot.id;
  }, [bot.id]);

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
    const readFor = bot.id;
    const fetchOverviewAndPrompt = async () => {
      await flushBotPatches(bot.id);
      if (cancelled || readFor !== ownerId.current) return;
      if (want.overview) {
        void api(`/api/bots/${bot.id}/overview`)
          .then((data: BotOverview) => {
            if (cancelled || readFor !== ownerId.current) return;
            setSnapshot((s) => ({ ...(s.botId === readFor ? s : emptyOverview(readFor)), overview: data, overviewError: false }));
          })
          .catch(() => {
            if (!cancelled && readFor === ownerId.current) {
              setSnapshot((s) => ({ ...(s.botId === readFor ? s : emptyOverview(readFor)), overviewError: true }));
            }
          });
      }
      if (want.prompt) {
        void api(`/api/bots/${bot.id}/system-prompt`)
          .then((data: PromptPreviewData) => {
            if (cancelled || readFor !== ownerId.current) return;
            setSnapshot((s) => ({ ...(s.botId === readFor ? s : emptyOverview(readFor)), prompt: data, promptError: false }));
          })
          .catch(() => {
            if (!cancelled && readFor === ownerId.current) {
              setSnapshot((s) => ({ ...(s.botId === readFor ? s : emptyOverview(readFor)), promptError: true }));
            }
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

type HistorySnapshot = { botId: string; rows: HistoryRow[] | null; revision: string | null; error: boolean };
const emptyHistory = (botId: string): HistorySnapshot => ({ botId, rows: null, revision: null, error: false });

export function useBotHistory(bot: Bot, active: boolean) {
  const dispatch = useStoreDispatch(), { flushBotPatches } = useStoreActions();
  // Rows, revision and error belong to the bot they were read for: on the first render after a switch the previous bot's
  // snapshot must not show under the new bot, so anything read for another bot is treated as empty.
  const [snapshot, setSnapshot] = useState<HistorySnapshot>(() => emptyHistory(bot.id));
  const view = snapshot.botId === bot.id ? snapshot : emptyHistory(bot.id);
  const { rows, revision, error } = view;
  const request = useRef(0);
  const ownerId = useRef(bot.id);
  const [rollingBack, setRollingBack] = useState(false);
  // Each rollback owns the flag only while it is the newest one: a rollback that ends after a bot switch must not clear another's.
  const rollbackOp = useRef(0);
  const [rollbackTarget, setRollbackTarget] = useState<{ id: string; expectedRevision: string } | null>(null);

  useEffect(() => {
    ownerId.current = bot.id;
    request.current++;
    setSnapshot(emptyHistory(bot.id));
    setRollbackTarget(null);
    setRollingBack(false);
    rollbackOp.current++;
  }, [bot.id]);

  const load = useCallback(() => {
    const readFor = bot.id;
    if (readFor !== ownerId.current) return Promise.resolve();
    const current = ++request.current;
    setSnapshot((s) => (s.botId === readFor ? { ...s, error: false } : emptyHistory(readFor)));
    return flushBotPatches(bot.id)
      .then(() => api(`/api/bots/${bot.id}/history?limit=100`))
      .then((data: { rows: HistoryRow[]; revision: string }) => {
        if (current !== request.current || readFor !== ownerId.current) return;
        setSnapshot({ botId: readFor, rows: data.rows, revision: data.revision, error: false });
      })
      .catch(() => {
        if (current === request.current && readFor === ownerId.current) {
          setSnapshot((s) => ({ ...(s.botId === readFor ? s : emptyHistory(readFor)), error: true }));
        }
      });
  }, [bot.id, flushBotPatches]);

  useEffect(() => {
    if (!active) return;
    void load();
    return () => { request.current++; };
  }, [active, load]);

  const rollback = async (target: { id: string; expectedRevision: string }) => {
    if (rollingBack) return;
    const rollbackFor = bot.id;
    const op = ++rollbackOp.current;
    setRollbackTarget(null);
    setRollingBack(true);
    try {
      await flushBotPatches(bot.id);
      await api(`/api/bots/${bot.id}/history/rollback`, {
        method: "POST",
        body: JSON.stringify(target),
      });
    } catch (e: unknown) {
      dispatch({ type: "error", message: e instanceof Error ? e.message : t("botOverview.undoFailed") });
    } finally {
      if (rollbackFor === ownerId.current) await load();
      if (op === rollbackOp.current) setRollingBack(false);
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
      title={t("botOverview.restoreSoul.title")}
      body={t("botOverview.restoreSoul.body")}
      confirmLabel={t("botOverview.restoreSoul.confirm")}
      tone="neutral"
      returnFocusRef={returnFocusRef}
      onCancel={() => setRollbackTarget(null)}
      onConfirm={() => { if (rollbackTarget) void rollback(rollbackTarget); }}
    />
  );
}
