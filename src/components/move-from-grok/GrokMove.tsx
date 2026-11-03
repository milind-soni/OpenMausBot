import { ArrowLeft, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { GrokBotMark } from "@/components/GrokBotMark";
import { trapTab } from "@/components/onboarding/WelcomeFlow";
import { track } from "@/lib/analytics";
import {
  closeGrokMove, foundExports, goToGrokMoveTarget, grokErrorText, grokMoveRows, lookForGrokBot, missingRoutines, moveGrokBot, NOTHING_FOUND,
  type GrokLook, type GrokMoved, type GrokMoveRequest, type GrokMoveRow,
} from "@/lib/grok-move";
import { t } from "@/lib/i18n";
import { localSetupImport } from "@/lib/setup-import";
import { useStore } from "@/state/store";
import { grokMovePlan, grokRedactions, parseGrokExport, type GrokBot, type GrokMovePlan } from "../../../shared/grok-import";
import { GrokMoveFinish } from "./GrokMoveFinish";
import { GrokMovePreview, type GrokMovePending } from "./GrokMovePreview";
import { GrokMoveStart } from "./GrokMoveStart";

function plansFor(bots: readonly GrokBot[], look: GrokLook): GrokMovePending {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { plans: bots.map((bot) => grokMovePlan(bot, { timeZone })), redacted: bots.reduce((total, bot) => total + grokRedactions(bot), 0), missing: missingRoutines(bots, look) };
}

/** The one Grok Bot move, full window, wherever it starts: bring back what the Bot wrote, see what comes over, then a
 * checklist of what still needs the person. Going to a checklist row steps aside for it, and one tap comes back. */
export function GrokMove({ request }: { request: GrokMoveRequest }) {
  const { state, dispatch } = useStore();
  const local = localSetupImport(state.config?.cloudHome === true);
  const [look, setLook] = useState<GrokLook>(NOTHING_FOUND);
  const [pending, setPending] = useState<GrokMovePending | null>(null);
  const [moved, setMoved] = useState<GrokMoved[]>([]);
  const [finishing, setFinishing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const [away, setAway] = useState(false);
  const told = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    if (local) void lookForGrokBot().then(setLook);
  }, [local]);
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  useEffect(() => {
    if (!away) root.current?.focus({ preventScroll: true });
  }, [away]);

  const found = useMemo(() => foundExports(look.files), [look.files]);

  const bring = useCallback((reply: string) => {
    try {
      setPending(plansFor(parseGrokExport(reply), look));
      setError("");
    } catch (cause) {
      setError(grokErrorText(cause));
    }
  }, [look]);

  const given = useRef(request.reply);
  useEffect(() => {
    if (!given.current) return;
    bring(given.current);
    given.current = undefined;
  }, [bring]);

  const add = async (plans: readonly GrokMovePlan[]) => {
    setAdding(true);
    setError("");
    try {
      const done: GrokMoved[] = [];
      for (const plan of plans) done.push(await moveGrokBot(plan, dispatch));
      track("team_imported", { members: done.length, source: "grok", mode: "add", format: "package" });
      setMoved((now) => [...now, ...done]);
      setPending(null);
      setFinishing(true);
      if (!told.current && done[0]) {
        told.current = true;
        request.onMoved?.(done[0].bot.id);
      }
    } catch (cause) {
      setError(grokErrorText(cause));
    } finally {
      setAdding(false);
    }
  };

  const rows = useMemo(
    () => grokMoveRows(moved, { instances: state.instances, routines: state.routines, webhooks: state.webhooks, seen }),
    [moved, state.instances, state.routines, state.webhooks, seen],
  );

  const open = (row: GrokMoveRow) => {
    setSeen((now) => new Set(now).add(row.key));
    setAway(true);
    goToGrokMoveTarget(row.target, dispatch);
  };
  const comeBack = () => {
    dispatch({ type: "toggleSettings", open: false });
    dispatch({ type: "togglePlugins", open: false });
    setAway(false);
  };
  const finish = () => {
    dispatch({ type: "toggleAppSettings", open: false });
    dispatch({ type: "showChat" });
    closeGrokMove();
  };
  const moveAnother = () => {
    setFinishing(false);
    setError("");
    refresh();
  };

  if (away) {
    return (
      <button type="button" data-grok-move-back onClick={comeBack}
        className="ui-button ui-button-primary fixed left-1/2 top-14 z-[80] min-h-9 -translate-x-1/2 whitespace-nowrap px-4 text-[14px] shadow-lg">
        {t("grokMove.backToChecklist")}
      </button>
    );
  }

  const step = finishing ? 3 : pending ? 2 : 1;
  const movedNames = [...new Set(moved.map((item) => item.plan.name.toLowerCase())), ...state.bots.flatMap((bot) => bot.installedPackage ? [bot.installedPackage.name.toLowerCase()] : [])];
  const body: ReactNode = finishing
    ? <GrokMoveFinish moved={moved} rows={rows} onOpen={open} onAnother={moveAnother} onDone={finish} />
    : pending
    ? <GrokMovePreview pending={pending} takenNames={state.bots.map((bot) => bot.name)} adding={adding} error={error} onAdd={() => void add(pending.plans)} />
    : <GrokMoveStart local={local} found={found} look={look} movedNames={movedNames} error={error}
        onBring={bring} onFound={(bot) => setPending(plansFor([bot], look))} onError={setError} />;

  return (
    <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="grok-move-title" data-grok-move={step}
      onKeyDown={(event) => {
        trapTab(event, root.current);
        if (event.key !== "Escape" || adding) return;
        event.stopPropagation();
        if (pending) setPending(null);
        else if (!finishing) closeGrokMove();
      }}
      className="welcome-screen fixed inset-0 z-[70] overflow-y-auto bg-app outline-none">
      <div className="sticky top-0 z-10 flex h-12 items-center justify-between bg-app/90 px-3 backdrop-blur">
        {pending && !adding
          ? <button type="button" onClick={() => setPending(null)} aria-label={t("grokMove.back")} title={t("grokMove.back")} className="flex size-8 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"><ArrowLeft size={17} /></button>
          : <span className="flex size-8 items-center justify-center" aria-hidden="true"><GrokBotMark size={18} /></span>}
        {!finishing && <button type="button" disabled={adding} onClick={closeGrokMove} aria-label={t("common.close")} title={t("common.close")} className="flex size-8 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-40"><X size={17} /></button>}
      </div>
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5 px-4 pb-12 pt-2 sm:pt-6">{body}</div>
    </div>
  );
}
