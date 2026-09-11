import { useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, RefreshCw } from "lucide-react";
import { useStore, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ProviderMark } from "./ProviderIcons";

export function engineReady(instance: InstanceInfo): boolean {
  return instance.snapshot.state === "available" &&
    (instance.access === "custom" || instance.snapshot.authenticated !== false);
}

const providers: Record<string, string> = {
  claudeAgent: "Anthropic", codex: "OpenAI", grok: "xAI", grokAgent: "xAI",
  kimiAgent: "Moonshot AI", droidAgent: "Factory", cursorAgent: "Cursor",
  antigravityAgent: "Google", opencodeGo: "OpenCode", qwenAgent: "Qwen",
  hermesAgent: "Nous Research", piAgent: "pi.dev",
};

/** One disclosure, not a second settings dialog. Keep its children mounted so
 * closing a card does not abandon an in-progress sign-in or a CLI path draft. */
export function EngineCard({ instance, children }: { instance: InstanceInfo; children: ReactNode }) {
  const ready = engineReady(instance);
  const email = instance.snapshot.authenticated === true ? instance.snapshot.account?.email : undefined;
  const subtitle = email ?? (instance.access === "custom"
    ? t("engines.library.custom")
    : providers[instance.driverKind] ?? instance.driverKind);
  // Some CLIs return their executable name rather than a version. Do not show
  // duplicated labels such as “Grok · grok”; retain the raw value in details.
  const version = instance.snapshot.version?.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/)?.[0];
  return (
    <details data-engine-card={instance.instanceId} className="group/engine min-w-0 rounded-2xl border border-hairline/40 bg-card transition-colors open:col-span-full open:border-hairline/70 hover:border-hairline/70">
      <summary className="cursor-pointer list-none rounded-2xl p-4 outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-hairline/30 bg-panel">
            <ProviderMark driverKind={instance.driverKind} size={28} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold tracking-[-0.015em] text-ink" title={instance.displayName}>{instance.displayName}</div>
            <div className="mt-1 truncate text-[12px] text-ink-secondary" title={subtitle}>{subtitle}</div>
          </div>
          <ChevronDown size={16} aria-hidden="true" className="shrink-0 text-ink-secondary transition-transform group-open/engine:rotate-180 motion-reduce:transition-none" />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium", ready ? "bg-success/10 text-success" : "bg-control text-ink-secondary")}>
            {ready ? <Check size={12} aria-hidden="true" /> : <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />}
            {ready ? t("onboarding.engines.ready") : t("onboarding.engines.needsSetup")}
          </span>
          {ready ? (
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

export function EngineSections({ instances, renderEngine }: {
  instances: InstanceInfo[];
  renderEngine: (instance: InstanceInfo) => ReactNode;
}) {
  // Flat, instance-keyed siblings keep forms and sign-in state alive when a
  // refreshed status moves a card between groups. Separate section parents
  // would remount it and discard unsaved input.
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] items-start gap-3">
    {[true, false].flatMap((ready) => {
      const rows = instances.filter((instance) => engineReady(instance) === ready);
      if (!rows.length) return [];
      const label = t(ready ? "onboarding.engines.ready" : "onboarding.engines.needsSetup");
      return [
        <div key={`heading-${ready}`} className={cn("col-span-full flex items-center justify-between gap-3", !ready && instances.some(engineReady) && "mt-4")}>
          <h2 className="text-[12px] font-semibold text-ink-secondary">{label}</h2>
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
  return <button type="button" disabled={busy} onClick={async () => {
    setBusy(true);
    try { await refreshInstances(); } finally { setBusy(false); }
  }} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] font-medium text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
    <RefreshCw size={13} aria-hidden="true" className={cn(busy && "animate-spin")} />
    {busy ? t("common.checking") : t("engines.library.refresh")}
  </button>;
}
