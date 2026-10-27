// Settings → Import: everything that brings work in from elsewhere, in one place. "From your AI apps" is the welcome
// tour's import step (the same rows, client and server route); "From Grok Bot" is the same Grok Bot import as Templates.
import { BookOpen, Check, Info, Loader2, Plug } from "lucide-react";
import { useEffect, useState } from "react";

import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { importOutcome, localSetupImport, setupImportApi, skillsSummary, toolsSummary, type SetupImportClient } from "@/lib/setup-import";
import { useStore } from "@/state/store";
import { detectionCount, detectionSources, type SetupDetection, type SetupImportResult } from "../../shared/setup-import";
import { GrokBotMark } from "./GrokBotMark";
import { GrokImportFlow } from "./GrokImportFlow";
import { ImportRow } from "./onboarding/beats/ImportBeat";

const buttonClass = "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-40";

export interface AiAppsImportViewProps {
  local: boolean;
  /** undefined while looking; null when the look failed. */
  detection: SetupDetection | null | undefined;
  chosen: { skills: boolean; tools: boolean };
  status: "idle" | "working" | "failed";
  result: SetupImportResult | null;
  onChoose: (chosen: { skills: boolean; tools: boolean }) => void;
  onBring: () => void;
}

export function AiAppsImportView({ local, detection, chosen, status, result, onChoose, onBring }: AiAppsImportViewProps) {
  const working = status === "working";
  let body;
  if (!local) body = <p className="text-[13px] text-ink-secondary">{t("settings.import.appsLocalOnly")}</p>;
  else if (detection === undefined) {
    body = <p className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("settings.import.appsLooking")}</p>;
  } else if (result) {
    const { line, notes, done } = importOutcome(result);
    body = (
      <div role="status" className="flex items-start gap-3">
        <span className={cn("mt-px flex size-5 shrink-0 items-center justify-center rounded-full", done ? "bg-success/15 text-success" : "bg-control text-ink-secondary")}>
          {done ? <Check size={12} strokeWidth={3} /> : <Info size={12} strokeWidth={2.5} />}
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-ink">{line}</p>
          {notes.map((note) => <p key={note} className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{note}</p>)}
        </div>
      </div>
    );
  } else if (!detection || detectionCount(detection) === 0) {
    body = <p className="text-[13px] text-ink-secondary">{detection === null ? t("onboarding.import.error") : t("settings.import.appsNothing")}</p>;
  } else {
    body = (
      <>
        <div className="divide-y divide-hairline/40 overflow-hidden rounded-xl border border-hairline/40">
          {detection.skills.length > 0 && (
            <ImportRow icon={<BookOpen size={15} />} label={t("onboarding.import.skills")} summary={skillsSummary(detection)}
              hint={t("onboarding.import.skillsHint")} sources={detectionSources(detection.skills)} checked={chosen.skills}
              disabled={working} onChange={(skills) => onChoose({ ...chosen, skills })} />
          )}
          {detection.tools.length > 0 && (
            <ImportRow icon={<Plug size={15} />} label={t("onboarding.import.tools")} summary={toolsSummary(detection)}
              hint={t("onboarding.import.toolsHint")} sources={detectionSources(detection.tools)} checked={chosen.tools}
              disabled={working} onChange={(tools) => onChoose({ ...chosen, tools })} />
          )}
        </div>
        {status === "failed" && <p role="alert" className="mt-3 text-[13px] text-danger">{t("onboarding.import.error")}</p>}
        <button onClick={onBring} disabled={working || !(chosen.skills || chosen.tools)} className={cn(buttonClass, "mt-3")}>
          {working && <Loader2 size={14} className="animate-spin" />}
          {working ? t("onboarding.import.bringing") : t("onboarding.import.bring")}
        </button>
      </>
    );
  }
  return (
    <section data-import-section="apps" className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("settings.import.appsTitle")}</div>
      <div className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">{t("settings.import.appsSubtitle")}</div>
      <div className="mt-4">{body}</div>
    </section>
  );
}

/** The welcome step's importer, outside the tour: look, tick, bring in. */
function AiAppsImport({ client, local }: { client: SetupImportClient; local: boolean }) {
  const [detection, setDetection] = useState<SetupDetection | null | undefined>(undefined);
  const [chosen, setChosen] = useState({ skills: true, tools: true });
  const [status, setStatus] = useState<"idle" | "working" | "failed">("idle");
  const [result, setResult] = useState<SetupImportResult | null>(null);

  useEffect(() => {
    if (!local) return;
    const controller = new AbortController();
    client.detect(controller.signal).then(setDetection, () => setDetection(null));
    return () => controller.abort();
  }, [client, local]);

  const bring = async () => {
    if (!detection || status === "working") return;
    const request = { ...(chosen.skills && detection.skills.length ? { skills: true } : {}), ...(chosen.tools && detection.tools.length ? { tools: true } : {}) };
    if (!request.skills && !request.tools) return;
    setStatus("working");
    try {
      const brought = await client.apply(request);
      track("setup_import_applied", { skills: brought.skills?.added.length ?? 0, tools: brought.tools?.added.length ?? 0 });
      setResult(brought);
      setStatus("idle");
    } catch {
      setStatus("failed");
    }
  };

  return <AiAppsImportView local={local} detection={detection} chosen={chosen} status={status} result={result} onChoose={setChosen} onBring={() => void bring()} />;
}

export function GrokImportSection() {
  return (
    <section data-import-section="grok" className="rounded-xl bg-card p-4">
      <div className="flex items-center gap-2 text-[15px] font-medium text-ink"><GrokBotMark size={16} />{t("settings.import.grokTitle")}</div>
      <div className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">{t("settings.import.grokSubtitle")}</div>
      <div className="mt-4"><GrokImportFlow bare /></div>
    </section>
  );
}

export function ImportSettings({ client = setupImportApi }: { client?: SetupImportClient }) {
  const { state } = useStore();
  return (
    <div className="flex flex-col gap-4">
      <AiAppsImport client={client} local={localSetupImport(state.config?.cloudHome === true)} />
      <GrokImportSection />
    </div>
  );
}
