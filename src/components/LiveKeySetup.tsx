import { useEffect, useRef, useState } from "react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { liveDisclosure } from "@/lib/call-mode";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** The OpenAI key for GPT-Live. `compact` fits it inside a popover (the
 * call bar's gear, the call button's first-call prompt). */
export function LiveKeySetup({ onSaved, compact = false }: { onSaved: () => void; compact?: boolean }) {
  const { state, dispatch } = useStore();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const save = async () => {
    const value = key.trim();
    if (!value || saving) return;
    setSaving(true);
    setError(null);
    try {
      const status: ConfigStatus = window.ogb?.setCredential
        ? await window.ogb.setCredential("openaiLiveKey", value)
        : await api("/api/config", { method: "PUT", body: JSON.stringify({ live: { key: value } }) });
      dispatch({ type: "configStatus", config: status });
      // Saving the key may finish after the prompt was dismissed. Do not
      // turn that completed save into a call the user has already cancelled.
      if (!mounted.current) return;
      setKey("");
      onSaved();
    } catch (saveError) {
      if (mounted.current) setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  return (
    <form
      className={cn(
        "flex flex-col gap-2.5 rounded-xl border border-hairline bg-panel p-4 text-left",
        compact ? "w-full" : "w-[420px] max-w-[90vw]",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="text-[13.5px] font-medium text-ink">{t("call.live.keyTitle")}</div>
      <div className="text-[12.5px] leading-[1.45] text-ink-secondary">{t("call.live.keyExplain")}</div>
      {/* where Live is set up: what a call sends to OpenAI */}
      <div className="text-[12.5px] leading-[1.45] text-ink-secondary">{liveDisclosure({ cloudHome: state.config?.cloudHome === true })}</div>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        onChange={(event) => setKey(event.target.value)}
        placeholder="sk-…"
        aria-label={t("call.live.keyField")}
        className="rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/60"
      />
      {error && <div className="text-[12px] text-danger">{error}</div>}
      <button
        type="submit"
        disabled={!key.trim() || saving}
        className="self-start rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
      >
        {saving ? t("call.live.keySaving") : compact ? t("common.save") : t("call.live.keySaveAndCall")}
      </button>
    </form>
  );
}
