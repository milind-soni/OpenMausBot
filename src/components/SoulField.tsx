// The SOUL.md editor: the bot's standing instructions, byte-counted
// against the server cap, with a banner when the file on disk was edited
// outside the app. Edits go to the record through the normal bot patch;
// the server writes the mirror. A draft that is over the cap stays local
// and is never sent, so the counter is the only thing that turns red.
import { useEffect, useState } from "react";

import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { cn } from "@/lib/cn";
import { firstSentence, soulPatchFor, utf8Bytes } from "@/lib/soul";
import { api, useStore, type Bot } from "@/state/store";
import { inputCls } from "./bot-settings/field";

type SoulRead = { soul: string; revision: string; bytes: number; limit: number; file: string; drift: boolean; fileText?: string };

export function SoulField({
  bot,
  onPatch,
}: {
  bot: Bot;
  onPatch: (patch: { soul?: string; description?: string }) => void;
}) {
  const { dispatch, flushBotPatches } = useStore();
  const limit = BOT_PROFILE_LIMITS.soul;
  const [draft, setDraft] = useState(bot.soul ?? "");
  const [info, setInfo] = useState<SoulRead | null>(null);
  const [resolving, setResolving] = useState(false);

  // A new bot, or a server-side change (drift resolved, another client),
  // replaces the draft. While the user types, the draft leads.
  useEffect(() => {
    setDraft(bot.soul ?? "");
  }, [bot.id, bot.soul]);

  // Mirror path, drift state, and file text don't depend on the soul text
  // itself, so this must not key off bot.soul: onPatch updates it
  // optimistically on every keystroke, which would refetch on every
  // keystroke. bot.soulDrift changes whenever the server's drift state
  // changes, and resolve() below already calls refresh() explicitly after
  // Apply/Discard, so nothing is lost by dropping bot.soul here.
  const refresh = () => {
    return flushBotPatches(bot.id)
      .then(() => api(`/api/bots/${bot.id}/soul`))
      .then((read: SoulRead) => setInfo(read))
      .catch(() => setInfo(null));
  };
  useEffect(() => { void refresh(); }, [bot.id, bot.soulDrift, flushBotPatches]);

  const bytes = utf8Bytes(draft);
  const over = bytes > limit;
  const change = (value: string) => {
    setDraft(value);
    const patch = soulPatchFor(value, limit);
    if (patch) onPatch(patch);
  };
  const resolve = async (action: "apply-file" | "discard-file") => {
    if (resolving || !info?.revision || typeof info.fileText !== "string") return;
    setResolving(true);
    try {
      await flushBotPatches(bot.id);
      await api(`/api/bots/${bot.id}/soul/${action}`, {
        method: "POST",
        body: JSON.stringify({ fileText: info.fileText, expectedRevision: info.revision }),
      });
    } catch (error: unknown) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      await refresh();
      setResolving(false);
    }
  };
  const canMigrate = bot.description.length > 400 && !(bot.soul ?? "").trim();

  return (
    <div className="block">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label htmlFor={`bot-soul-${bot.id}`} className="text-[13px] text-ink-secondary">
          Standing instructions (SOUL.md)
        </label>
        {canMigrate && (
          <button
            type="button"
            disabled={resolving}
            onClick={() => onPatch({ soul: bot.description, description: firstSentence(bot.description) })}
            className="rounded-md px-1.5 py-1 text-[11.5px] font-medium text-accent-text hover:bg-accent/10"
          >
            Move instructions into SOUL.md
          </button>
        )}
      </div>
      {info?.drift && (
        <div className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-ink">
          <div className="font-medium">SOUL.md on disk was edited outside the app.</div>
          <div className="mt-1 text-ink-secondary">
            The bot keeps using the saved version until you choose. File: <span className="break-all">{info.file}</span>
          </div>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-control p-2 text-[11.5px]">{info.fileText}</pre>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={resolving} onClick={() => void resolve("apply-file")} className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50">
              Use the file
            </button>
            <button type="button" disabled={resolving} onClick={() => void resolve("discard-file")} className="rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50">
              Keep the saved version
            </button>
          </div>
        </div>
      )}
      <textarea
        id={`bot-soul-${bot.id}`}
        className={cn(inputCls, "min-h-[220px] resize-y font-mono leading-relaxed", over && "ring-2 ring-red-500/60")}
        placeholder="Who this bot is and the rules it never breaks. Keep it short; put step-by-step procedure into a skill."
        aria-invalid={over || undefined}
        disabled={resolving}
        value={draft}
        onChange={(e) => change(e.target.value)}
      />
      <div className="mt-1.5 flex items-start justify-between gap-3 text-[11px] text-ink-secondary">
        <span>
          In this bot’s context on every turn.{info ? <> Mirrored to <span className="break-all">{info.file}</span>.</> : null}
        </span>
        <span className={cn("shrink-0 tabular-nums", over && "font-medium text-red-500")}>
          {bytes.toLocaleString()} / {limit.toLocaleString()} bytes{over ? " — not saved" : ""}
        </span>
      </div>
    </div>
  );
}
