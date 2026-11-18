import { Box, Check, Cloud, Globe, Monitor, Power, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Bot, ConfigStatus } from "@/state/store";
import type { PlaceView } from "../../shared/place-view";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { pageOnRemoteServer } from "@/lib/local-computer";
import { placeOffered, type Place } from "@/lib/place";
import type { LocaleKey } from "@/locales";

export type WorksOnMode = Place | "off" | null;

const WORKS_ON_CHOICES = [
  [null, "vm.dest.auto", "computer.dest.autoDesc", Sparkles],
  ["cloud", "place.cloud", "computer.dest.cloudDesc", Cloud],
  ["vm", "vm.dest.vm", "computer.dest.vmDesc", Box],
  ["local", "vm.dest.local", "computer.dest.localDesc", Monitor],
  ["browser", "vm.dest.browser", "computer.dest.browserDesc", Globe],
  ["off", "vm.dest.off", "computer.dest.offDesc", Power],
] as const satisfies ReadonlyArray<readonly [WorksOnMode, LocaleKey, LocaleKey, LucideIcon]>;

export function worksOnChoices(config: Parameters<typeof placeOffered>[1], capabilities: DesktopCapabilities) {
  return WORKS_ON_CHOICES.filter(([mode]) => mode === null || mode === "off" || (placeOffered(mode, config) && !(mode === "local" && pageOnRemoteServer(capabilities))));
}

export function worksOnSelected(mode: WorksOnMode, computer: Bot["computer"], capabilities: DesktopCapabilities): boolean {
  return mode === null ? !computer || (computer === "local" && pageOnRemoteServer(capabilities)) : computer === mode;
}

export function placeManagedBy(mode: WorksOnMode, cloudBackend: Bot["cloudBackend"], policy: ConfigStatus["managedPolicy"]): string | undefined {
  const kind = mode === "local" ? "thisComputer" : mode === "vm" ? "localVm" : mode === "cloud" ? (cloudBackend === "vps" ? "vps" : "box") : null;
  return policy && kind && !policy.computers[kind] ? t("policy.managedBy", { organization: policy.organizationName }) : undefined;
}

export interface WorksOnOption {
  mode: WorksOnMode;
  labelKey: LocaleKey;
  descriptionKey: LocaleKey;
  Icon: LucideIcon;
  selected: boolean;
  managedBy?: string;
  disabled: boolean;
  unavailableTitle?: string;
  note?: string;
  issue: boolean;
  view: PlaceView;
}

export function WorksOnGrid({ options, onSelect }: { options: readonly WorksOnOption[]; onSelect: (mode: WorksOnMode) => void }) {
  return (
    <div role="group" aria-label={t("computer.destinationAria")} className="mt-3 grid auto-rows-fr grid-cols-2 gap-2">
      {options.map(({ mode, labelKey, descriptionKey, Icon, selected, managedBy, disabled, unavailableTitle, note, issue, view }) => (
        <button
          key={mode ?? "auto"}
          disabled={disabled}
          title={unavailableTitle}
          onClick={() => onSelect(mode)}
          type="button"
          aria-pressed={selected}
          className={cn(
            "min-w-0 rounded-lg border px-2.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card",
            selected
              ? "border-accent/60 bg-accent/10 text-ink"
              : "border-hairline/50 bg-panel/30 text-ink-secondary",
            disabled
              ? "cursor-not-allowed"
              : "hover:border-accent/40 hover:bg-control/60",
          )}
        >
          <span className="flex items-center gap-2 text-[12px] font-medium leading-4">
            {selected ? <Check size={14} className="shrink-0 text-accent" /> : <Icon size={14} className="shrink-0 text-ink-secondary" />}
            <span>{t(labelKey)}</span>
          </span>
          <span className="mt-1.5 block text-[11px] leading-4 text-ink-secondary">
            {managedBy ?? note ?? (disabled ? view.line : issue ? view.short : t(descriptionKey))}
          </span>
        </button>
      ))}
    </div>
  );
}
