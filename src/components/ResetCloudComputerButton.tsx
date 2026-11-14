import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { api } from "@/state/store";
import { busyBoatView } from "@/lib/local-computer";
import { t } from "@/lib/i18n";

export interface CloudResetView {
  computer: string | null | undefined;
  cloudBackend: string;
  canManage: boolean;
  busy: boolean;
  pending: boolean;
  phase: string;
  boatState: string | null;
  refusal: string | undefined;
}

/** Offered only on the person's explicit Cloud computer, with no work on it: start failed, or it shows starting while no turn runs. */
export function cloudComputerResettable(view: CloudResetView): boolean {
  if (view.computer !== "cloud" || view.cloudBackend !== "box" || !view.canManage || view.busy || view.pending) return false;
  if (view.phase === "error") return view.refusal === "cc-no-start";
  return view.phase === "busy-boat" && busyBoatView(view.boatState, false).spinner;
}

/** What the panel says after the reset route answered: Boat may accept a deletion it has not finished yet. */
export function resetNoteKey(result: unknown): "computer.reset.pending" | null {
  return result !== null && typeof result === "object" && (result as { pending?: unknown }).pending === true ? "computer.reset.pending" : null;
}

/** Deletes the bot's cloud computer after the person confirms; its next message makes a fresh one. */
export function ResetCloudComputerButton({ botId, botName, view, onReset }: {
  botId: string;
  botName: string;
  view: CloudResetView;
  onReset: () => void;
}) {
  const [resetting, setResetting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The note outlives the button: after a reset the panel goes back to checking, which hides the button.
  const offered = cloudComputerResettable(view);
  if (!offered && !note) return null;
  const reset = () => {
    if (resetting || !window.confirm(t("computer.reset.confirm", { name: botName }))) return;
    setResetting(true);
    setProblem(null);
    setNote(null);
    api(`/api/bots/${botId}/computer/remove`, { method: "POST", body: "{}" })
      .then((result) => {
        const key = resetNoteKey(result);
        setNote(key && t(key, { name: botName }));
        onReset();
      })
      .catch((error) => setProblem(error instanceof Error ? error.message : String(error)))
      .finally(() => setResetting(false));
  };
  return (
    <>
      {offered && <button
        type="button"
        onClick={reset}
        disabled={resetting}
        aria-busy={resetting}
        className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-60"
      >
        {resetting ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
        {t("computer.reset.button")}
      </button>}
      {note && <p role="status" className="text-[12px] text-ink-secondary">{note}</p>}
      {problem && <p role="alert" className="text-[12px] text-danger">{problem}</p>}
    </>
  );
}
