import { useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { api, type ConfigStatus } from "@/state/store";

/** What a paired phone calls this computer; empty keeps the default. Saved when the field loses focus or on Enter. */
export function ComputerNameRow({ saved, onSaved, className }: { saved: string; onSaved: (name: string) => void; className?: string }) {
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(saved), [saved]);

  async function save() {
    const next = draft.trim();
    if (saving || next === saved) return;
    setSaving(true);
    setError(null);
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ computerName: next }) });
      onSaved(config.computerName ?? next);
    } catch (e) {
      setError(t("remote.computerName.error", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-computer-name className={cn("flex flex-col gap-1", className)}>
      <label htmlFor="computer-name" className="text-[13px] font-medium text-ink">{t("remote.computerName.title")}</label>
      <input id="computer-name" value={draft} disabled={saving} placeholder={t("remote.computerName.placeholder")}
        aria-describedby="computer-name-help" onChange={(event) => setDraft(event.target.value)} onBlur={() => void save()}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        className="w-full max-w-xs rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none" />
      <p id="computer-name-help" className="text-[12px] leading-4 text-ink-secondary">{t("remote.computerName.help")}</p>
      {error ? <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p> : null}
    </div>
  );
}
