import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AUTO_COMPACT_AROUND_TOKENS,
  COMPACT_AROUND_PRESETS,
  DEFAULT_EXTRACTION_PROMPT,
  formatTokenK,
  VECTOR_BUDGET_PRESETS,
  VECTOR_PROMPT_MAX,
} from "../../shared/compact-around";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { shortPath } from "@/lib/short-path";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { Switch } from "./SettingsPrimitives";

export function CompactAroundSettings() {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const enabled = state.config?.compaction?.enabled !== false;
  const compactAround = state.config?.compaction?.compactAround ?? null;
  const vectorBudget = state.config?.compaction?.vectorBudget ?? null;
  const savedPrompt = state.config?.compaction?.prompt ?? null;
  const keepVectors = state.config?.compaction?.keepVectors === true;
  const microVectors = state.config?.compaction?.microVectorsEnabled === true;
  const archiveDir = state.config?.compaction?.vectorArchiveDir ?? null;
  const envOverride = state.config?.compaction?.envOverride ?? null;
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [promptDraft, setPromptDraft] = useState(savedPrompt ?? DEFAULT_EXTRACTION_PROMPT);

  useEffect(() => {
    setPromptDraft(savedPrompt ?? DEFAULT_EXTRACTION_PROMPT);
  }, [savedPrompt]);

  const patch = async (compaction: Record<string, unknown>) => {
    if (envOverride !== null && "compactAround" in compaction) return;
    setSaving(JSON.stringify(compaction));
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ compaction }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setSaving(null);
    }
  };

  const aroundOff = !enabled;
  const aroundAuto = enabled && compactAround === null;
  const vectorAuto = vectorBudget === null;
  const ceilingCap = compactAround ?? AUTO_COMPACT_AROUND_TOKENS;
  const detailsDisabled = aroundOff || saving !== null;
  const promptIsStandard = (savedPrompt ?? DEFAULT_EXTRACTION_PROMPT) === DEFAULT_EXTRACTION_PROMPT;
  const promptDirty = promptDraft !== (savedPrompt ?? DEFAULT_EXTRACTION_PROMPT);
  const canPick = Boolean(window.ogb?.pickFolder);

  const pickArchive = async () => {
    const chosen = await window.ogb?.pickFolder?.(archiveDir || undefined);
    if (chosen) void patch({ vectorArchiveDir: chosen, keepVectors: true });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="text-[13px] leading-relaxed text-ink-secondary">
        <p>
          Keep this chat going on a local model without starting over. The size below is a{" "}
          <span className="text-ink">hard cap</span> on the live backend context: when fill hits that
          number, OpenMausBot writes a state-vector recap,{" "}
          <span className="text-ink">resets the host session</span>, and leaves your conversation in
          place. A line in the thread marks the refresh.
        </p>
        <p className="mt-2">
          Pick a smaller cap if you want lighter memory use; a larger cap lets each stretch run longer
          before a forced reset. Auto is a good default. Off turns this off completely and leaves local
          chats as they were before Keep chatting. Cloud chats are unchanged.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-[13px] font-medium text-ink">Context size limit</div>
        <div
          role="radiogroup"
          aria-label="Context size limit"
          aria-disabled={envOverride !== null}
          className="flex flex-wrap overflow-hidden rounded-lg border border-hairline/40"
        >
          <button
            type="button"
            role="radio"
            aria-checked={aroundOff}
            disabled={envOverride !== null || saving !== null}
            onClick={() => void patch({ enabled: false })}
            className={cn(
              "flex-1 px-3 py-1.5 text-[13px]",
              aroundOff ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Off
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={aroundAuto}
            disabled={envOverride !== null || saving !== null}
            onClick={() => void patch({ enabled: true, compactAround: null })}
            className={cn(
              "flex-1 border-l border-hairline/40 px-3 py-1.5 text-[13px]",
              aroundAuto ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Auto
          </button>
          {COMPACT_AROUND_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={enabled && compactAround === preset}
              disabled={envOverride !== null || saving !== null}
              onClick={() => void patch({ enabled: true, compactAround: preset })}
              className={cn(
                "flex-1 border-l border-hairline/40 px-3 py-1.5 text-[13px] tabular-nums",
                enabled && compactAround === preset ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {formatTokenK(preset)}
            </button>
          ))}
        </div>
        <p className="text-[12px] leading-relaxed text-ink-secondary">
          {envOverride !== null
            ? `A computer setting is overriding this (${formatTokenK(envOverride)}).`
            : aroundOff
              ? "Keep chatting is off. Local chats will not force a recap or reset the host session."
              : aroundAuto
                ? "Auto caps the live backend context at a comfortable size for most computers, then forces a reset with a recap."
                : `Hard cap at ${formatTokenK(compactAround!)}. At that size the host session resets with a recap; this chat stays and a line appears in the thread.`}
        </p>
      </div>

      <div className={cn("flex flex-col gap-2", aroundOff && "opacity-50")}>
        <div className="text-[13px] font-medium text-ink">How much to remember</div>
        <div
          role="radiogroup"
          aria-label="How much to remember"
          className="flex flex-wrap overflow-hidden rounded-lg border border-hairline/40"
        >
          <button
            type="button"
            role="radio"
            aria-checked={vectorAuto}
            disabled={detailsDisabled}
            onClick={() => void patch({ vectorBudget: null })}
            className={cn(
              "px-3 py-1.5 text-[13px]",
              vectorAuto ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Auto
          </button>
          {VECTOR_BUDGET_PRESETS.map((preset) => {
            const over = preset > ceilingCap;
            return (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={vectorBudget === preset}
                disabled={detailsDisabled || over}
                title={over ? `Limited to the context size limit (${formatTokenK(ceilingCap)})` : undefined}
                onClick={() => void patch({ vectorBudget: preset })}
                className={cn(
                  "border-l border-hairline/40 px-3 py-1.5 text-[13px] tabular-nums",
                  vectorBudget === preset ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                {formatTokenK(preset)}
              </button>
            );
          })}
        </div>
        <p className="text-[12px] leading-relaxed text-ink-secondary">
          The recap injected into the fresh host session. Auto is enough for most people. Raise it if the bot
          forgets the next step after a reset.
        </p>
      </div>

      <div className={cn("flex flex-col gap-2", aroundOff && "opacity-50")}>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="vector-prompt" className="text-[13px] font-medium text-ink">
            Recap notes
          </label>
          <button
            type="button"
            disabled={detailsDisabled || promptIsStandard}
            onClick={() => {
              setPromptDraft(DEFAULT_EXTRACTION_PROMPT);
              void patch({ prompt: null });
            }}
            className="rounded-md px-1.5 py-1 text-[11.5px] font-medium text-accent-text hover:bg-accent/10 disabled:opacity-40"
          >
            Reset to standard
          </button>
        </div>
        <textarea
          id="vector-prompt"
          className="min-h-[160px] w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          maxLength={VECTOR_PROMPT_MAX}
          aria-label="Recap notes"
          value={promptDraft}
          disabled={detailsDisabled}
          onChange={(e) => setPromptDraft(e.target.value)}
          onBlur={() => {
            if (!promptDirty) return;
            const next = promptDraft.trim();
            void patch({ prompt: next === DEFAULT_EXTRACTION_PROMPT || !next ? null : next });
          }}
        />
        <div className="flex items-start justify-between gap-3 text-[11px] text-ink-secondary">
          <span>Standard recap: goal, this turn, facts, places, cautions, constraints, and what is still open.</span>
          <span className="shrink-0 tabular-nums">
            {promptDraft.length.toLocaleString()} / {VECTOR_PROMPT_MAX.toLocaleString()}
          </span>
        </div>
      </div>

      <div className={cn("flex flex-col gap-2", aroundOff && "opacity-50")}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-medium text-ink">Build a running notebook</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
              After each turn, update a short notebook for this chat so the next refresh keeps early truths. Off by
              default. Saved under each bot&apos;s task folder as notebook.md.
            </p>
          </div>
          <Switch
            checked={microVectors}
            disabled={detailsDisabled}
            aria-label="Build a running notebook"
            onClick={() => void patch({ microVectorsEnabled: !microVectors })}
          />
        </div>
      </div>

      <div className={cn("flex flex-col gap-2", aroundOff && "opacity-50")}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-medium text-ink">Save each recap as a file</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
              Keep a markdown copy of every refresh so you can compare them later. Off by default.
            </p>
          </div>
          <Switch
            checked={keepVectors}
            disabled={detailsDisabled}
            aria-label="Save each recap as a file"
            onClick={() => void patch({ keepVectors: !keepVectors })}
          />
        </div>
        {keepVectors ? (
          <div className="flex items-center gap-2">
            <div
              className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink"
              title={archiveDir ?? undefined}
            >
              {archiveDir ? (
                shortPath(archiveDir, home)
              ) : (
                <span className="font-sans text-ink-secondary">Default — each bot&apos;s private folder</span>
              )}
            </div>
            {canPick ? (
              <button
                type="button"
                onClick={() => void pickArchive()}
                disabled={detailsDisabled}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                <FolderOpen size={14} />
                Choose…
              </button>
            ) : null}
            {archiveDir ? (
              <button
                type="button"
                onClick={() => void patch({ vectorArchiveDir: null })}
                disabled={detailsDisabled}
                className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50"
              >
                Reset
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
