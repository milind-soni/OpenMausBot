// The setup checklist on an OMB Cloud home (docs/cloud-pro.md, "Setup
// checklist"): one quiet card from the Cloud's first open until an engine is
// signed in and a bot has finished a turn there, or until the person hides
// it. Each step's state is read from the Cloud or this app (lib/cloud-setup),
// never ticked by hand, and each action opens what already exists: the engine
// sign-in, Move to Cloud, the chat's composer, the lending switch. No dialogs.
// Desktop and self-hosted installs never see it; they keep the welcome flow.
import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Cloud } from "lucide-react";
import { cloudMoveOffer, CloudMoveSuggestion, useCloudMove } from "@/components/CloudMove";
import { engineReady } from "@/components/EngineLibrary";
import { cn } from "@/lib/cn";
import { CLOUD_SETUP_HIDDEN, CLOUD_SETUP_MOVE_SKIPPED, cloudSetupItems, cloudSetupStage, type CloudSetupItem, type CloudSetupStep } from "@/lib/cloud-setup";
import { appendComposerDraft, getDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";
import { hintSeenPatch, type WelcomeViewer } from "@/lib/onboarding";
import type { LocaleKey } from "@/locales";
import { api, useStore } from "@/state/store";

const TITLE: Record<CloudSetupStep, LocaleKey> = {
  engine: "cloudSetup.engine.title", move: "cloudSetup.move.title", try: "cloudSetup.try.title", lend: "cloudSetup.lend.title",
};

/** Whether the Cloud lists a computer lent to it (GET /api/shared-computers,
 * the owner's own view), asked again when the window comes back to the front. */
function useLentComputer(active: boolean): boolean | null {
  const [lent, setLent] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const check = () => {
      void api<{ computers?: unknown }>("/api/shared-computers")
        .then((body) => { if (alive) setLent(Array.isArray(body?.computers) && body.computers.length > 0); })
        .catch(() => {});
    };
    check();
    window.addEventListener?.("focus", check);
    return () => { alive = false; window.removeEventListener?.("focus", check); };
  }, [active]);
  return lent;
}

function draftHas(id: string, text: string): boolean {
  try { return getDraft(globalThis.localStorage, id).includes(text); } catch { return false; }
}

export function CloudSetup({ viewer }: { viewer: WelcomeViewer | null }) {
  const { state, dispatch } = useStore();
  const [hidden, setHidden] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveSkipped, setMoveSkipped] = useState(false);
  const [lendFailed, setLendFailed] = useState(false);
  // One step open at a time: the first one not done, or the one chosen.
  const [chosen, setChosen] = useState<CloudSetupStep | null>(null);
  const record = state.config?.onboarding;
  // Not now on the move shows as skipped at once, before the Cloud answers.
  const onboarding = moveSkipped && record ? { ...record, hintsSeen: [...record.hintsSeen, CLOUD_SETUP_MOVE_SKIPPED] } : record;
  const facts = {
    viewer, connected: state.connected, enginesKnown: state.instances.length > 0,
    engineReady: state.instances.some(engineReady), onboarding,
  };
  const stage = hidden ? "hidden" : cloudSetupStage(facts);
  const shown = stage === "shown";
  const moveBridge = shown ? window.ogb?.cloudMove : undefined;
  const move = useCloudMove(moveBridge);
  const lendBridge = shown && window.ogb?.platform === "darwin" ? window.ogb.cloudLending : undefined;
  const lent = useLentComputer(Boolean(lendBridge));
  // Hidden or finished: the one-time Move to Cloud card works as it always did.
  if (stage === "hidden" || stage === "done") return <CloudMoveSuggestion />;
  if (!shown) return null;

  const items = cloudSetupItems({
    ...facts,
    move: moveBridge && move.overview ? { phase: move.state.phase, action: move.state.action, suggest: move.overview.suggest } : null,
    ...(lendBridge ? { lend: { lent } } : {}),
  });
  const moveItem = items.find((item) => item.id === "move");
  const todo = items.filter((item) => item.status === "todo");
  const current = (todo.find((item) => item.id === chosen) ?? todo[0])?.id;
  const remember = (id: string) => {
    const patch = hintSeenPatch(record, id);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then((config) => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  const hide = () => {
    setHidden(true);
    // Bringing bots over is one of these steps, so hiding setup is its Not now too.
    if (moveBridge && moveItem?.status === "todo") void moveBridge.dismiss().catch(() => {});
    remember(CLOUD_SETUP_HIDDEN);
  };
  const tryIt = () => {
    const bot = state.bots.find((candidate) => candidate.id === state.selectedId && !candidate.hidden) ?? state.bots.find((candidate) => !candidate.hidden);
    if (!bot) return;
    dispatch({ type: "select", id: bot.id });
    const draftId = `bot:${bot.id}:${bot.threadId}`, example = t("cloudSetup.try.example");
    if (!draftHas(draftId, example)) appendComposerDraft(draftId, example);
  };
  const hint = (key: LocaleKey) => <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t(key)}</p>;
  const action = (label: LocaleKey, onClick: () => void) => <button type="button" className="ui-button mt-2" onClick={onClick}>{t(label)}</button>;

  const details = (id: CloudSetupStep) => {
    if (id === "engine") return <>
      {hint("cloudSetup.engine.hint")}
      {/* In the chat view the sign-in is already what the window shows. */}
      {state.activeView !== "chat" && action("cloudSetup.engine.action", () => dispatch({ type: "showChat" }))}
    </>;
    if (id === "move") {
      if (!moveBridge) return null;
      // Open once asked for, and while a move is under way or has stopped.
      if (moveOpen || (moveItem?.status === "todo" && move.state.phase !== "idle")) {
        return cloudMoveOffer(moveBridge, move, { start: () => {}, notNow: () => { setMoveSkipped(true); remember(CLOUD_SETUP_MOVE_SKIPPED); } });
      }
      return <>{hint("cloudSetup.move.hint")}{action("cloudSetup.move.action", () => setMoveOpen(true))}</>;
    }
    if (id === "try") return <>
      {hint("cloudSetup.try.hint")}
      <p className="mt-1.5 rounded-lg bg-inset px-2.5 py-2 text-[12.5px] leading-relaxed text-ink">{t("cloudSetup.try.example")}</p>
      {facts.engineReady && action("cloudSetup.try.action", tryIt)}
    </>;
    return <>
      {hint("cloudSetup.lend.hint")}
      {action("cloudSetup.lend.action", () => { setLendFailed(false); void lendBridge?.open().catch(() => setLendFailed(true)); })}
      {lendFailed && <p role="alert" className="mt-1.5 text-[12px] text-danger">{t("cloudSetup.lend.failed")}</p>}
    </>;
  };
  const row = (item: CloudSetupItem) => {
    const pending = item.status === "todo", open = item.id === current;
    const title = <>
      {t(TITLE[item.id])}
      {item.status === "skipped"
        ? <span> · {t("cloudSetup.skipped")}</span>
        : <span className="sr-only"> ({t(pending ? "cloudSetup.stepTodo" : "cloudSetup.stepDone")})</span>}
    </>;
    return <li key={item.id} data-cloud-setup-step={item.id} data-status={item.status} className="flex gap-2.5">
      {pending
        ? <Circle size={16} aria-hidden="true" className="mt-px shrink-0 text-ink-secondary" />
        : <CheckCircle2 size={16} aria-hidden="true" className="mt-px shrink-0 text-success" />}
      <div className="min-w-0 flex-1">
        {pending && !open
          ? <button type="button" aria-expanded={false} onClick={() => setChosen(item.id)} className="block w-full text-left text-[13px] text-ink hover:text-accent">{title}</button>
          : <p className={cn("text-[13px]", pending ? "font-medium text-ink" : "text-ink-secondary")}>{title}</p>}
        {open && details(item.id)}
      </div>
    </li>;
  };

  return <aside aria-labelledby="cloud-setup-title" data-cloud-setup className="fixed bottom-4 left-4 z-40 max-h-[calc(100dvh-32px)] w-[300px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-xl border border-hairline/40 bg-panel p-3.5 text-ink shadow-2xl shadow-black/20">
    <div className="flex items-center gap-2.5">
      <Cloud size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      <h2 id="cloud-setup-title" className="min-w-0 flex-1 text-[13.5px] font-semibold">{t("cloudSetup.title")}</h2>
      <span className="shrink-0 text-[12px] text-ink-secondary">{t("cloudSetup.progress", { done: items.filter((item) => item.status !== "todo").length, total: items.length })}</span>
    </div>
    <ol className="mt-3 flex flex-col gap-3">{items.map(row)}</ol>
    <button type="button" className="mt-2 py-1 text-[12px] text-ink-secondary hover:text-ink" onClick={hide}>{t("cloudSetup.hide")}</button>
  </aside>;
}
