// A collapsed-by-default preview of the settings-derived prompt, built from
// GET /api/bots/:id/system-prompt (server/system-prompt.ts's
// previewSystemPrompt, the same builder a real turn uses). Pure
// presentational: the dialog owns the fetch and the open/closed state.
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/cn";

export interface PromptPreviewData {
  sections: Array<{ id: string; label: string; text: string; bytes: number }>;
  totalBytes: number;
  approxTokens: number;
  note: string;
}

export function PromptPreview({
  data,
  error,
  open,
  onToggle,
}: {
  data: PromptPreviewData | null;
  error?: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-xl bg-card p-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="text-[15px] font-medium text-ink">
          {data
            ? `Prompt preview · ${data.totalBytes.toLocaleString()} bytes ≈ ${data.approxTokens.toLocaleString()} tokens`
            : "Prompt preview"}
        </span>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>

      {open && !data && error && (
        <div className="mt-3 text-[13px] text-ink-secondary">Couldn’t load the prompt preview.</div>
      )}

      {open && !data && !error && <div className="mt-3 text-[13px] text-ink-secondary">Loading…</div>}

      {open && data && (
        <div className="mt-3 flex flex-col gap-2">
          {data.sections.map((section) => (
            <details key={section.id} className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
              <summary className="flex cursor-pointer items-center justify-between gap-3 text-[13px] text-ink">
                <span>{section.label}</span>
                <span className="shrink-0 tabular-nums text-ink-secondary">{section.bytes.toLocaleString()} bytes</span>
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink">
                {section.text}
              </pre>
            </details>
          ))}
          {data.note && <div className="text-[11px] text-ink-secondary">{data.note}</div>}
        </div>
      )}
    </div>
  );
}
