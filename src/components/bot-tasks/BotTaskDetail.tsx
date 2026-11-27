import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Send } from "lucide-react";

import type { BotTask, BotTaskGithubRef } from "../../../shared/bot-tasks";
import { BOT_TASK_LIMITS } from "../../../shared/bot-tasks";
import { githubRefLabel, loadBotTask, loadBotTaskMergeHead, postBotTask, syncBotTask, type BotTasksStatus } from "@/lib/bot-tasks";
import { onBotTaskChanged } from "@/lib/bot-task-events";
import { t } from "@/lib/i18n";
import { ApiError } from "@/state/api";
import { ConfirmDialog } from "../ConfirmDialog";
import { BotTaskActivityList } from "./BotTaskActivity";
import { GithubRefChip, StatusChip, When } from "./parts";

const GITHUB_STATE = { open: "botTasks.githubState.open", closed: "botTasks.githubState.closed", merged: "botTasks.githubState.merged" } as const;

const useSlow = (active: boolean) => {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(timer);
  }, [active]);
  return slow;
};

export function BotTaskDetail({ id, settings, botName, onChanged }: {
  id: string;
  settings: BotTasksStatus;
  botName: (id: string) => string;
  onChanged: () => void;
}) {
  const [task, setTask] = useState<BotTask | null>(null);
  const [ownerName, setOwnerName] = useState("");
  const [failed, setFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState("");
  const [merge, setMerge] = useState(false);
  const [confirmation, setConfirmation] = useState<{ id: string; ref: BotTaskGithubRef; text: string; sha?: string } | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState("");
  const [posted, setPosted] = useState("");
  const loading = useRef<AbortController | null>(null);
  const postButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    setFailed(false);
    try {
      const answer = await loadBotTask(id, controller.signal);
      if (controller.signal.aborted) return;
      setTask(answer.task);
      setOwnerName(answer.ownerName);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    }
  }, [id]);
  useEffect(() => { void load(); return () => loading.current?.abort(); }, [load]);
  useEffect(() => onBotTaskChanged((changed) => { if (changed === id) void load(); }), [id, load]);
  const slow = useSlow(!task && !failed);

  if (!task) {
    return failed ? (
      <section role="alert" className="px-6 py-16 text-center">
        <p className="text-[13px] text-ink-secondary">{t("botTasks.detail.loadFailed")}</p>
        <button type="button" className="ui-button ui-button-md mt-4 rounded-full" onClick={() => void load()}>{t("common.tryAgain")}</button>
      </section>
    ) : (
      <div className="flex min-h-40 items-center justify-center" aria-busy="true">
        {slow && <span role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={16} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />{t("botTasks.loading")}</span>}
      </div>
    );
  }

  const github = task.github;
  const canSync = Boolean(github) && settings.enabled && settings.githubSync;
  const canPost = Boolean(github) && canSync && settings.allowOutboundComments;
  const canMerge = canPost && settings.allowMerge && github?.kind !== "issue" && task.githubState?.state !== "merged";

  const sync = async () => {
    setSyncing(true);
    setSyncError("");
    try {
      const answer = await syncBotTask(task.id);
      setTask(answer.task);
      onChanged();
    } catch {
      setSyncError(t("botTasks.sync.failed"));
    } finally {
      setSyncing(false);
    }
  };
  const preparePost = async () => {
    if (!github) return;
    const draft = { id: task.id, ref: github, text: text.trim() };
    setPostError("");
    if (!canMerge || !merge) {
      setConfirmation(draft);
      return;
    }
    setPosting(true);
    try {
      const { sha } = await loadBotTaskMergeHead(draft.id, draft.ref);
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid pull request head.");
      setConfirmation({ ...draft, sha });
    } catch (error) {
      setPostError(error instanceof ApiError && error.status === 409 ? error.message : t("botTasks.post.failed"));
    } finally {
      setPosting(false);
    }
  };

  const post = async () => {
    if (!confirmation || confirmation.id !== id) return;
    setPosting(true);
    setPostError("");
    try {
      const answer = await postBotTask(confirmation.id, confirmation.text, confirmation.ref, confirmation.sha);
      setTask(answer.task);
      setText("");
      setMerge(false);
      setComposing(false);
      setPosted(answer.url);
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.body?.code === "merge_completed") {
        setMerge(false);
        setPostError(`${t("botTasks.activity.merged")} ${t("botTasks.post.failed")}`);
        void load();
      } else {
        setPostError(error instanceof ApiError && error.status === 409 ? error.message : t("botTasks.post.failed"));
      }
    } finally {
      setPosting(false);
      setConfirmation(null);
    }
  };

  return (
    <article aria-labelledby="bot-task-title" data-bot-task={task.id} className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h2 id="bot-task-title" dir="auto" className="break-words text-[17px] font-semibold leading-6 tracking-[-0.01em] text-ink">{task.title}</h2>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] leading-[18px] text-ink-secondary">
          <StatusChip status={task.status} />
          <span className="min-w-0 truncate">{t("botTasks.ownedBy", { name: ownerName || botName(task.ownerBotId) })}</span>
          {github && <GithubRefChip githubRef={github} />}
          {task.githubState && <span className="text-ink-tertiary">{t(GITHUB_STATE[task.githubState.state])}</span>}
          <span className="ms-auto flex items-center gap-1 text-[12px] text-ink-tertiary">{t("botTasks.updated")} <When at={task.updatedAt} /></span>
        </div>
        {(canSync || canPost) && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {canSync && (
              <button type="button" data-bot-task-sync="" className="ui-button ui-button-md rounded-full" disabled={syncing} onClick={() => void sync()}>
                <RefreshCw size={16} aria-hidden="true" className={syncing ? "animate-spin motion-reduce:animate-none" : undefined} />
                {syncing ? t("botTasks.sync.running") : t("botTasks.sync.now")}
              </button>
            )}
            {canPost && !composing && (
              <button type="button" data-bot-task-compose="" className="ui-button ui-button-md rounded-full" onClick={() => { setComposing(true); setPosted(""); }}>
                <Send size={16} aria-hidden="true" />{t("botTasks.post.open")}
              </button>
            )}
            {syncError && <span role="alert" className="text-[12px] leading-4 text-danger">{syncError}</span>}
            {posted && <span role="status" className="text-[12px] leading-4 text-ink-secondary">{t("botTasks.post.done")}</span>}
          </div>
        )}
      </header>

      {canPost && composing && github && (
        <section aria-labelledby="bot-task-post" data-bot-task-post="" className="flex flex-col gap-2 rounded-xl border border-hairline/40 p-4">
          <label id="bot-task-post" htmlFor="bot-task-post-text" className="text-[13px] font-medium leading-[18px] text-ink">{t("botTasks.post.label", { ref: githubRefLabel(github) })}</label>
          <p className="text-[12px] leading-4 text-ink-secondary">{t("botTasks.post.public")}</p>
          <textarea id="bot-task-post-text" dir="auto" rows={4} value={text} maxLength={BOT_TASK_LIMITS.textMax} disabled={posting}
            onChange={(event) => setText(event.target.value)}
            className="min-h-24 w-full resize-y rounded-lg border border-hairline/60 bg-app px-3 py-2 text-[13px] leading-[18px] text-ink outline-none focus-visible:border-focus disabled:opacity-50" />
          {canMerge && (
            <label className="flex items-center gap-2 text-[13px] leading-[18px] text-ink">
              <input type="checkbox" checked={merge} disabled={posting} onChange={(event) => setMerge(event.target.checked)} className="size-4 accent-[var(--color-accent)]" />
              {t("botTasks.post.merge")}
            </label>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {postError && <span role="alert" className="me-auto text-[12px] leading-4 text-danger">{postError}</span>}
            <button type="button" className="ui-button ui-button-md rounded-full" disabled={posting} onClick={() => { setComposing(false); setPostError(""); }}>{t("common.cancel")}</button>
            <button ref={postButton} type="button" data-bot-task-post-send="" className="ui-button ui-button-md ui-button-primary rounded-full" disabled={posting || !text.trim()}
              onClick={() => void preparePost()}>{t("botTasks.post.send")}</button>
          </div>
        </section>
      )}

      <section aria-labelledby="bot-task-activity" className="flex flex-col gap-1">
        <h3 id="bot-task-activity" className="text-[13px] font-medium leading-[18px] text-ink">{t("botTasks.activity.title")}</h3>
        <BotTaskActivityList activity={task.activity} taskRepo={github?.repo} ownerName={botName} />
      </section>

      <ConfirmDialog open={confirmation?.id === id} pending={posting} returnFocusRef={postButton}
        title={t(confirmation?.sha ? "botTasks.post.confirmMergeTitle" : "botTasks.post.confirmTitle")}
        body={<>
          {t(confirmation?.sha ? "botTasks.post.confirmMergeBody" : "botTasks.post.confirmBody", { ref: confirmation ? githubRefLabel(confirmation.ref) : "" })}
          {confirmation?.sha && <code dir="ltr" className="ui-code-chip mt-2 block w-fit">{confirmation.sha.slice(0, 12)}</code>}
        </>}
        confirmLabel={t(confirmation?.sha ? "botTasks.post.confirmMerge" : "botTasks.post.confirm")}
        onCancel={() => setConfirmation(null)} onConfirm={() => void post()} />
    </article>
  );
}
