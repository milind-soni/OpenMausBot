import { useEffect, useState } from "react";

import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { cn } from "@/lib/cn";
import { firstSentence, soulPatchFor, utf8Bytes } from "@/lib/soul";
import { useStore, type Bot } from "@/state/store";
import { useBotEditor } from "./bot-settings/BotEditorContext";
import { inputCls } from "./bot-settings/field";
import { t } from "@/lib/i18n";

type SoulRead = { soul: string; revision: string; bytes: number; limit: number; file: string; drift: boolean; fileText?: string };

export function SoulField({
  bot,
  onPatch,
  simple,
}: {
  bot: Bot;
  onPatch: (patch: { soul?: string; description?: string }) => void;
  simple?: { label: string; placeholder: string };
}) {
  const { dispatch, flushBotPatches } = useStore();
  const { request: api } = useBotEditor();
  const limit = BOT_PROFILE_LIMITS.soul;
  const [draft, setDraft] = useState(bot.soul ?? "");
  const [info, setInfo] = useState<SoulRead | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    setDraft(bot.soul ?? "");
  }, [bot.id, bot.soul]);

  // Must not key off bot.soul: onPatch updates it on every keystroke, which would refetch per keystroke.
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
        <label htmlFor={`bot-soul-${bot.id}`} className={simple ? "text-[12px] text-ink-secondary" : "text-[13px] text-ink-secondary"}>
          {simple ? simple.label : t("botIdentity.soul.label")}
        </label>
        {!simple && canMigrate && (
          <button
            type="button"
            disabled={resolving}
            onClick={() => onPatch({ soul: bot.description, description: firstSentence(bot.description) })}
            className="rounded-md px-1.5 py-1 text-[12px] font-medium text-accent-text hover:bg-accent/10"
          >
            {t("botIdentity.soul.moveToFile")}
          </button>
        )}
      </div>
      {info?.drift && (
        <div className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-ink">
          <div className="font-medium">{t("botIdentity.soul.externalEdit")}</div>
          <div className="mt-1 text-ink-secondary">
            {t("botIdentity.soul.externalEditHelp")} {t("botIdentity.soul.fileLabel")} <span className="break-all">{info.file}</span>
          </div>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-control p-2 text-[12px]">{info.fileText}</pre>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={resolving} onClick={() => void resolve("apply-file")} className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50">
              {t("botIdentity.soul.useFile")}
            </button>
            <button type="button" disabled={resolving} onClick={() => void resolve("discard-file")} className="rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50">
              {t("botIdentity.soul.keepSaved")}
            </button>
          </div>
        </div>
      )}
      <textarea
        id={`bot-soul-${bot.id}`}
        className={cn(
          inputCls,
          simple ? "min-h-[140px] resize-y rounded-xl text-[14px] leading-relaxed" : "min-h-[220px] resize-y font-mono leading-relaxed",
          over && "ring-2 ring-red-500/60",
        )}
        placeholder={simple ? simple.placeholder : t("bot.soul.placeholder")}
        aria-invalid={over || undefined}
        disabled={resolving}
        value={draft}
        onChange={(e) => change(e.target.value)}
      />
      {(!simple || over) && <div className="mt-1.5 flex items-start justify-between gap-3 text-[11px] text-ink-secondary">
        <span>
          {!simple && <>{t("botIdentity.soul.contextHelp")}{info?.file ? <> {t("botIdentity.soul.mirroredTo")} <span className="break-all">{info.file}</span>.</> : null}</>}
        </span>
        <span className={cn("shrink-0 tabular-nums", over && "font-medium text-red-500")}>
          {bytes.toLocaleString()} / {limit.toLocaleString()} bytes{over ? " — not saved" : ""}
        </span>
      </div>}
    </div>
  );
}
