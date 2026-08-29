// The Browser tab, expanded: the same native view the panel shows, given the
// whole main column. Opened by clicking the small preview in the computer
// panel; closing hands the tab back to the panel. Control (Take control /
// Hand back) is the same lease the panel uses, so a hold survives the swap.
import { useEffect, useState } from "react";
import { Globe, X } from "lucide-react";
import { z } from "zod";
import { useStore, type Bot } from "@/state/store";
import { BrowserPanel } from "./BrowserPanel";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

const controlSnapshotSchema = z.looseObject({
  held: z.boolean().optional().default(false),
  helpReason: z.string().nullable().optional().default(null),
});

export function BrowserWorkspace({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
  const [controlPending, setControlPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api(`/api/bots/${bot.id}/computer/control`)
      .then((raw) => {
        if (!alive) return;
        const snap = controlSnapshotSchema.parse(raw);
        dispatch({
          type: "computerControl",
          botId: bot.id,
          held: snap.held === true,
          helpReason: snap.helpReason,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const controlAction = async (action: "take" | "release"): Promise<boolean> => {
    setControlPending(true);
    setError(null);
    try {
      const snap = controlSnapshotSchema.parse(await api(`/api/bots/${bot.id}/computer/control`, {
        method: "POST",
        body: JSON.stringify({ action }),
      }));
      dispatch({
        type: "computerControl",
        botId: bot.id,
        held: snap.held === true,
        helpReason: snap.helpReason,
      });
      // A successful HTTP response is not enough: only advance Electron's
      // native input gate when the durable lease reached the requested state.
      return snap.held === (action === "take");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setControlPending(false);
    }
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <header className="flex min-h-[60px] items-center gap-3 border-b border-hairline/40 px-5 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Globe size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14px] font-semibold text-ink">{bot.name}'s browser</h1>
          <p className="truncate text-[11.5px] text-ink-secondary">
            Live page · click into it to take over · the bot pauses while you drive
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          aria-label="Back to the small browser"
          title="Back to the panel"
        >
          <X size={18} />
        </button>
      </header>
      {error && <div className="mx-5 mt-3 text-[12px] text-danger">{error}</div>}
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-4">
        <BrowserPanel
          bot={bot}
          control={control}
          controlPending={controlPending}
          onControl={controlAction}
          size="expanded"
          onCollapse={onClose}
        />
      </div>
    </main>
  );
}
