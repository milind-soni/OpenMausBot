import { Check, Loader2 } from "lucide-react";
import { useState } from "react";

import { api, useStore, type ConfigStatus } from "@/state/store";

/** Workspace-owned voice credential. Agent profiles only choose a voice. */
export function WorkspaceVoiceSettings() {
  const { state, dispatch } = useStore();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = state.config?.tts?.configured === true;

  const save = async () => {
    const nextKey = key.trim();
    if (!nextKey || saving) return;
    setSaving(true);
    setError(null);
    try {
      const status: ConfigStatus = window.ogb?.setCredential
        ? await window.ogb.setCredential("ttsKey", nextKey)
        : await api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { key: nextKey } }) });
      dispatch({ type: "configStatus", config: status });
      setKey("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-hairline/40 bg-inset p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[13px] font-medium text-ink">Workspace voice</div>
          <div className="mt-0.5 text-[11.5px] text-ink-secondary">One ElevenLabs connection shared by every agent.</div>
        </div>
        <span className={configured ? "text-[11.5px] text-success" : "text-[11.5px] text-ink-secondary"}>{configured ? "Connected" : "Not connected"}</span>
      </div>
      <div className="mt-3 flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void save()}
          placeholder={configured ? "Paste to replace the saved key" : "Paste ElevenLabs API key"}
          aria-label="Workspace ElevenLabs key"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-card px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !key.trim()}
          className="inline-flex w-[74px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
        </button>
      </div>
      {error ? <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div> : null}
    </div>
  );
}
