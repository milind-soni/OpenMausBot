// "Bring what you already use": the skills and MCP servers another AI tool keeps on this computer, in one step.
import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, Check, ChevronDown, Info, Plug } from "lucide-react";
import { GrokBotMark } from "@/components/GrokBotMark";
import { GrokImportFlow } from "@/components/GrokImportFlow";
import { ClaudeMark, CodexMark, CursorMark, PresetProviderMark } from "@/components/ProviderIcons";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { importOutcome, skillsSummary, toolsSummary, type SetupImportClient } from "@/lib/setup-import";
import { detectionSources, type SetupDetection, type SetupImportResult, type SetupSource } from "../../../../shared/setup-import";
import { PrimaryButton, QuietButton, staggerIndex, type BeatProps } from "./shared";

/** Long enough to read one line; a result with notes waits for Continue. */
export const RESULT_READ_MS = 1_800;

function SourceMarks({ sources }: { sources: readonly SetupSource[] }) {
  const marks = [...new Set(sources.map((source) => (source === "claudeDesktop" ? "claudeCode" : source)))];
  return (
    <span className="mr-1.5 inline-flex items-center gap-1 align-[-1px]" aria-hidden="true">
      {marks.map((source) => {
        switch (source) {
          case "codex": return <CodexMark key={source} size={12} />;
          case "cursor": return <CursorMark key={source} size={12} />;
          case "gemini": return <PresetProviderMark key={source} preset="google" size={12} />;
          default: return <ClaudeMark key={source} size={12} />;
        }
      })}
    </span>
  );
}

export function ImportRow({ icon, label, summary, hint, sources, checked, disabled, onChange }: {
  icon: ReactNode;
  label: string;
  summary: string;
  hint: string;
  sources: readonly SetupSource[];
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={cn("flex items-start gap-3 px-3.5 py-3 transition-colors", disabled ? "cursor-default" : "cursor-pointer hover:bg-raised/40")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 cursor-[inherit] accent-[var(--color-accent)]"
      />
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-ink-secondary">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        {/* One run of text, so a narrow card wraps the summary under the label, marks included. */}
        <span className="text-[13px] leading-5 text-ink-secondary">
          <span className="mr-2 text-[14px] font-medium text-ink">{label}</span>
          <SourceMarks sources={sources} />
          {summary}
        </span>
        <span className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{hint}</span>
      </span>
    </label>
  );
}

/** "Have a Grok Bot? Paste its link": optional, opens the same Grok Bot import as Templates and Settings, inline. */
export function GrokBotRow({ label, open, disabled, onToggle }: { label: string; open: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-raised/40 disabled:cursor-default"
      >
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center"><GrokBotMark size={15} /></span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] leading-5 text-ink-secondary">
            <span className="mr-2 text-[14px] font-medium text-ink">{label}</span>
            {t("onboarding.import.grokSummary")}
          </span>
          <span className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("onboarding.import.grokHint")}</span>
        </span>
        <ChevronDown size={15} className={cn("mt-0.5 shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-3.5 pb-3.5">
          <GrokImportFlow bare />
          <QuietButton onClick={onToggle} className="mt-2">{t("onboarding.import.grokNotNow")}</QuietButton>
        </div>
      )}
    </div>
  );
}

export function ImportBeat({ onNext, onSkip, setMascot, bump, detection, client, result, onResult, onBusy }: BeatProps & {
  detection: SetupDetection;
  client: SetupImportClient;
  /** Kept by the flow, so going back shows what was added instead of offering it again. */
  result: SetupImportResult | null;
  onResult: (result: SetupImportResult) => void;
  /** While bringing in, so the flow holds Back: leaving would offer the step again and start a second run. */
  onBusy?: (busy: boolean) => void;
}) {
  const hasSkills = detection.skills.length > 0;
  const hasTools = detection.tools.length > 0;
  const [chosen, setChosen] = useState({ skills: hasSkills, tools: hasTools });
  const [status, setStatus] = useState<"idle" | "working" | "failed">("idle");
  const [advanceSoon, setAdvanceSoon] = useState(false);
  const [grokOpen, setGrokOpen] = useState(false);
  const working = status === "working";

  useEffect(() => {
    setMascot(result ? "proud" : "receiving");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!advanceSoon) return;
    const timer = setTimeout(onNext, RESULT_READ_MS);
    return () => clearTimeout(timer);
  }, [advanceSoon, onNext]);

  const bring = async () => {
    if (working || !(chosen.skills || chosen.tools)) return;
    setStatus("working");
    onBusy?.(true);
    setMascot("working");
    try {
      const brought = await client.apply({ ...(chosen.skills ? { skills: true } : {}), ...(chosen.tools ? { tools: true } : {}) });
      track("setup_import_applied", { skills: brought.skills?.added.length ?? 0, tools: brought.tools?.added.length ?? 0 });
      onResult(brought);
      setStatus("idle");
      setMascot("proud");
      bump("success");
      if (!importOutcome(brought).notes.length) setAdvanceSoon(true);
    } catch {
      setStatus("failed");
      setMascot("confused");
      bump("failure");
    } finally {
      onBusy?.(false);
    }
  };

  const skip = () => {
    track("setup_import_skipped", { skills: detection.skills.length, tools: detection.tools.length });
    onSkip();
  };

  if (result) {
    const { line, notes, done } = importOutcome(result);
    return (
      <div className="flex flex-col">
        <div className="animate-rise mt-4 flex items-start gap-3 rounded-xl border border-hairline/40 bg-card px-3.5 py-3" role="status">
          <span className={cn("check-in mt-px flex size-5 shrink-0 items-center justify-center rounded-full",
            done ? "bg-success/15 text-success" : "bg-control text-ink-secondary")}>
            {done ? <Check size={12} strokeWidth={3} /> : <Info size={12} strokeWidth={2.5} />}
          </span>
          <div className="min-w-0">
            <p className="text-[14px] font-medium text-ink">{line}</p>
            {notes.map((note) => (
              <p key={note} className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{note}</p>
            ))}
          </div>
        </div>
        <PrimaryButton onClick={onNext} className="mt-5">
          {t("onboarding.continue")}
        </PrimaryButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <p className="animate-rise mt-1 text-[14px] text-ink-secondary">{t("onboarding.import.intro")}</p>
      <div
        className="animate-rise mt-4 divide-y divide-hairline/40 overflow-hidden rounded-xl border border-hairline/40 bg-card"
        style={staggerIndex(1)}
      >
        {hasSkills && (
          <ImportRow
            icon={<BookOpen size={15} />}
            label={t("onboarding.import.skills")}
            summary={skillsSummary(detection)}
            hint={t("onboarding.import.skillsHint")}
            sources={detectionSources(detection.skills)}
            checked={chosen.skills}
            disabled={working}
            onChange={(skills) => setChosen((now) => ({ ...now, skills }))}
          />
        )}
        {hasTools && (
          <ImportRow
            icon={<Plug size={15} />}
            label={t("onboarding.import.tools")}
            summary={toolsSummary(detection)}
            hint={t("onboarding.import.toolsHint")}
            sources={detectionSources(detection.tools)}
            checked={chosen.tools}
            disabled={working}
            onChange={(tools) => setChosen((now) => ({ ...now, tools }))}
          />
        )}
        <GrokBotRow label={t("onboarding.import.grok")} open={grokOpen} disabled={working} onToggle={() => setGrokOpen((open) => !open)} />
      </div>
      {status === "failed" && <p role="alert" className="mt-3 text-[13px] text-danger">{t("onboarding.import.error")}</p>}
      <PrimaryButton onClick={() => void bring()} disabled={working || !(chosen.skills || chosen.tools)} className="mt-5">
        {working ? t("onboarding.import.bringing") : t("onboarding.import.bring")}
      </PrimaryButton>
      <QuietButton onClick={skip} disabled={working} className="mt-3 self-center disabled:opacity-50">
        {t("onboarding.import.skip")}
      </QuietButton>
    </div>
  );
}
