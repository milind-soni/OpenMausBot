// Prompt library: browse built-in standing-instruction presets, import more
// from a GitHub repo the user names, preview, and apply to the SOUL draft.
// Applying goes through the normal SoulField patch path, so the byte cap,
// history, and drift logic keep single ownership; this component only ever
// proposes text. A replace of non-empty instructions needs a second click.
import { useEffect, useState } from "react";

import { utf8Bytes } from "@/lib/soul";
import { api } from "@/state/store";

interface Preset {
  id: string;
  label: string;
  description: string;
  text: string;
  source: string;
}

/** Built-ins first, imported after; duplicate ids are skipped (first wins),
 * and the total stays bounded so a hostile import cannot flood the panel. */
export function mergePresets(builtIns: Preset[], imported: Preset[]): Preset[] {
  const seen = new Set(builtIns.map((p) => p.id));
  const merged = [...builtIns];
  for (const preset of imported) {
    if (merged.length >= 200) break;
    if (seen.has(preset.id)) continue;
    seen.add(preset.id);
    merged.push(preset);
  }
  return merged;
}

export function PresetPreview({
  preset,
  hasExisting,
  onApply,
  onClose,
}: {
  preset: Preset;
  hasExisting: boolean;
  onApply: (text: string) => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const bytes = utf8Bytes(preset.text);
  const apply = () => {
    onApply(preset.text);
    onClose();
  };
  return (
    <div className="mt-2 rounded-lg border border-hairline/60 bg-inset p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[12.5px] font-medium text-ink">{preset.label}</div>
        <span className="shrink-0 text-[11px] tabular-nums text-ink-secondary">{bytes.toLocaleString()} bytes</span>
      </div>
      {preset.description && <div className="mt-0.5 text-[11.5px] text-ink-secondary">{preset.description}</div>}
      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-control p-2 font-mono text-[11.5px] leading-relaxed">{preset.text}</pre>
      {preset.source !== "built-in" && (
        <div className="mt-1 break-all text-[10.5px] text-ink-secondary">Imported from {preset.source}</div>
      )}
      <div className="mt-2 flex items-center gap-2">
        {confirming ? (
          <>
            <span className="text-[11.5px] text-ink">Replace the existing instructions with this preset?</span>
            <button type="button" onClick={apply} className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110">
              Replace
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover">
              Keep mine
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={hasExisting ? () => setConfirming(true) : apply}
              className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
            >
              {hasExisting ? "Replace instructions" : "Apply"}
            </button>
            {hasExisting && <span className="text-[11px] text-ink-secondary">Your current instructions will be overwritten.</span>}
            <button type="button" onClick={onClose} className="ml-auto rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover">
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function PromptLibrary({ hasExisting, onApply }: { hasExisting: boolean; onApply: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || presets || loading) return;
    setLoading(true);
    api("/api/prompt-library")
      .then((data: { presets: Preset[] }) => setPresets(data.presets))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open, presets, loading]);

  const importFromGitHub = async () => {
    if (importing || !source.trim()) return;
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const data = (await api(`/api/prompt-library/${encodeURIComponent(source.trim())}`)) as {
        presets: Preset[];
        errors: string[];
      };
      setPresets((current) => mergePresets(current ?? [], data.presets));
      setNotice(
        [
          data.presets.length ? `Imported ${data.presets.length} prompt${data.presets.length === 1 ? "" : "s"}.` : "",
          data.errors.length ? data.errors.join("; ") : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const preview = presets?.find((p) => p.id === previewId) ?? null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="rounded-md px-1.5 py-1 text-[11.5px] font-medium text-accent-text hover:bg-accent/10"
      >
        {open ? "Close prompt library" : "Prompt library"}
      </button>
      {notice && !open && <div className="sr-only">{notice}</div>}
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-[min(34rem,90vw)] rounded-xl border border-hairline/60 bg-raised p-3 shadow-lg">
          {presets === null && !error && <div className="p-2 text-[12px] text-ink-secondary">Loading prompts…</div>}
          {error && <div className="p-2 text-[12px] text-red-500">{error}</div>}
          {presets && (
            <div className="flex flex-col gap-1.5">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setPreviewId(previewId === preset.id ? null : preset.id)}
                  className="rounded-lg border border-hairline/40 bg-inset p-2 text-left hover:bg-raised-hover"
                >
                  <div className="text-[12.5px] font-medium text-ink">{preset.label}</div>
                  <div className="mt-0.5 line-clamp-2 text-[11px] text-ink-secondary">{preset.description}</div>
                </button>
              ))}
            </div>
          )}
          {preview && presets && (
            <PresetPreview preset={preview} hasExisting={hasExisting} onApply={onApply} onClose={() => setPreviewId(null)} />
          )}
          <div className="mt-3 border-t border-hairline/40 pt-2">
            <div className="text-[11.5px] text-ink-secondary">Import markdown prompts from a GitHub repo or file:</div>
            <div className="mt-1.5 flex gap-2">
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void importFromGitHub();
                  }
                }}
                placeholder="owner/repo or github.com/… URL"
                aria-label="GitHub source to import prompts from"
                className="min-w-0 flex-1 rounded-lg border border-hairline/60 bg-inset px-2 py-1.5 text-[12px] text-ink placeholder:text-ink-secondary/60"
              />
              <button
                type="button"
                disabled={importing || !source.trim()}
                onClick={() => void importFromGitHub()}
                className="shrink-0 rounded-lg bg-control px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {importing ? "Importing…" : "Import"}
              </button>
            </div>
            {(error || notice) && <div className={`mt-1.5 text-[11px] ${error ? "text-red-500" : "text-ink-secondary"}`}>{error ?? notice}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
