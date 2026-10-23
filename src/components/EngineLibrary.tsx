import { useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, RefreshCw } from "lucide-react";
import { useStore, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { InstanceProviderMark } from "./ProviderIcons";
import { isDirectModelDriver } from "../../shared/model-arrangement";

export function engineReady(instance: InstanceInfo): boolean {
  if (instance.driverKind === "clineAgent") {
    return instance.snapshot.state === "available" && instance.snapshot.authenticated === true;
  }
  return instance.snapshot.state === "available" &&
    (instance.access === "custom" || instance.snapshot.authenticated !== false);
}

const providers: Record<string, string> = {
  claudeAgent: "Anthropic", codex: "OpenAI", grok: "xAI", grokAgent: "xAI",
  kimiAgent: "Moonshot AI", droidAgent: "Factory", cursorAgent: "Cursor",
  antigravityAgent: "Google", opencodeGo: "OpenCode", qwenAgent: "Qwen",
  hermesAgent: "Nous Research", clineAgent: "Cline", piAgent: "pi.dev", mistral: "Mistral AI", cerebras: "Cerebras", groq: "Groq", meta: "Meta", museCode: "Meta", deepseekAgent: "DeepSeek",
};

export function providerName(instance: InstanceInfo): string {
  return providers[instance.driverKind] ?? instance.driverKind;
}

/** What a card that stands for several accounts says about all of them. */
export interface EngineCardSummary { title: string; subtitle: string; ready: boolean; status: string; action: string }

/** Children stay mounted so closing a card does not abandon an in-progress sign-in or a CLI path draft. */
export function EngineCard({ instance, children, summary }: { instance: InstanceInfo; children: ReactNode; summary?: EngineCardSummary }) {
  const ready = summary?.ready ?? engineReady(instance);
  const email = instance.snapshot.authenticated === true ? instance.snapshot.account?.email : undefined;
  const title = summary?.title ?? instance.displayName;
  const subtitle = summary?.subtitle ?? (instance.instanceId === "claudeApi" && instance.driverKind === "claudeAgent"
    ? t("model.connection.claudeApiSubtitle")
    : email ?? (instance.access === "custom" ? t("engines.library.custom") : providerName(instance)));
  // Some CLIs return their executable name rather than a version.
  const version = instance.snapshot.version?.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/)?.[0];
  return (
    <details data-engine-card={instance.instanceId} className={cn("group/engine min-w-0 rounded-2xl border border-hairline/40 border-l-[3px] bg-card transition-colors open:col-span-full open:border-hairline/70 hover:border-hairline/70", ready ? "border-l-success/55" : "border-l-warning/65")}>
      <summary className="cursor-pointer list-none rounded-2xl p-4 outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-hairline/30 bg-panel">
            <InstanceProviderMark instance={instance} size={28} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-secondary">
              {t(isDirectModelDriver(instance.driverKind) ? "model.connection.directBadge" : "model.connection.agentBadge")}
            </div>
            <div className="truncate text-[15px] font-semibold tracking-[-0.015em] text-ink" title={title}>{title}</div>
            <div className="mt-1 truncate text-[12px] text-ink-secondary" title={subtitle}>{subtitle}</div>
          </div>
          <ChevronDown size={16} aria-hidden="true" className="shrink-0 text-ink-secondary transition-transform group-open/engine:rotate-180 motion-reduce:transition-none" />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium", ready ? "bg-success/10 text-success" : "bg-control text-ink-secondary")}>
            {ready ? <Check size={12} aria-hidden="true" /> : <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />}
            {summary?.status ?? (ready ? t("onboarding.engines.ready") : instance.snapshot.state === "available" && instance.snapshot.authenticated === false
              ? t("model.signInRequired") : t("onboarding.engines.needsSetup"))}
          </span>
          {summary ? (
            <span className={cn("text-[11px] font-medium", ready ? "text-ink-secondary" : "text-accent-text")}>{summary.action}</span>
          ) : ready ? (
            <span className="text-[11px] tabular-nums text-ink-secondary">{version ? `v${version}` : t("engines.library.manage")}</span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-accent-text">
              {t("engines.library.setup")}<ArrowUpRight size={13} aria-hidden="true" />
            </span>
          )}
        </div>
      </summary>
      <div className="min-w-0 border-t border-hairline/40 p-4">{children}</div>
    </details>
  );
}

export function EngineSections({ instances, renderEngine, isReady = engineReady }: {
  instances: InstanceInfo[];
  renderEngine: (instance: InstanceInfo) => ReactNode;
  isReady?: (instance: InstanceInfo) => boolean;
}) {
  // Flat, instance-keyed siblings: separate section parents would remount a card that moves between groups and drop
  // unsaved input.
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] items-start gap-3">
    {[true, false].flatMap((ready) => {
      const rows = instances.filter((instance) => isReady(instance) === ready);
      if (!rows.length) return [];
      const label = t(ready ? "onboarding.engines.ready" : "onboarding.engines.needsSetup");
      return [
        <div key={`heading-${ready}`} data-connection-status={ready ? "ready" : "needs-setup"} className={cn("col-span-full flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5", ready ? "border-success/25 bg-success/[0.08]" : "border-warning/30 bg-warning/[0.09]", !ready && instances.some(isReady) && "mt-4")}>
          <h3 className={cn("flex items-center gap-2 text-[13px] font-semibold", ready ? "text-success" : "text-warning")}>
            {ready ? <Check size={15} aria-hidden="true" /> : <span aria-hidden="true" className="size-2 rounded-full bg-warning" />}
            {label}
          </h3>
          <span className="text-[11px] tabular-nums text-ink-secondary">{t(rows.length === 1 ? "engines.library.countOne" : "engines.library.count", { count: rows.length })}</span>
        </div>,
        ...rows.map((instance) => <div key={instance.instanceId} className="contents">{renderEngine(instance)}</div>),
      ];
    })}
    {instances.length === 0 && <p className="col-span-full py-4 text-[13px] text-ink-secondary">{t("engines.none")}</p>}
  </div>;
}

export function RefreshEngines() {
  const { refreshInstances } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  return <div>
    <button type="button" disabled={busy} onClick={async () => {
      setBusy(true);
      setError(null);
      setChecked(false);
      try { await refreshInstances({ reportErrors: true }); setChecked(true); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setBusy(false); }
    }} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] font-medium text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
      <RefreshCw size={13} aria-hidden="true" className={cn(busy && "animate-spin")} />
      {busy ? t("common.checking") : t("engines.library.refresh")}
    </button>
    {error && <p role="alert" className="mt-1 text-[12px] text-danger">{t("engineSetup.checkFailed", { reason: error })}</p>}
    {checked && <p role="status" className="mt-1 text-[11px] text-ink-secondary">{t("engineSetup.checked")}</p>}
  </div>;
}
