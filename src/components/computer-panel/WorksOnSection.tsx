import { Box, CalendarClock, Check, Cloud, Globe, Monitor, Power, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot, type InstanceInfo, type Task } from "@/state/store";
import { placeLabelKey } from "@/lib/place";
import { browserAvailable, browserUnavailableReason, builtInBrowserEnabled } from "@/lib/feature-flags";
import { routineRunLabel, routineRunTone } from "@/lib/routine-display";
import { approvalModeFor } from "../../../shared/approval-mode";
import type { CloudBackend } from "../../../shared/wire";
import type { Routine, RoutineRun } from "../../../shared/routines";
import { CloudBackendPicker } from "../CloudBackendPicker";

/** The "Works on" destination picker and the compact routines entry beneath
 * it. The profile default owns lifecycle actions; the Works on picker is
 * where they are chosen. */
export function WorksOnSection({
  profileBot,
  bot,
  liveTask,
  cloudBackend,
  cloudSupported,
  vmSupported,
  vpsSupported,
  localSelectable,
  localDisabledReason,
  isLinux,
  currentTeamComputer,
  selectedInstance,
  onUpdateComputerSelection,
  onWarnLocalAuto,
  openVmSettings,
  botRoutines,
  activeRoutineRun,
  onSelectRoutines,
}: {
  profileBot: Bot;
  bot: Bot;
  liveTask: Task | undefined;
  cloudBackend: CloudBackend;
  cloudSupported: boolean;
  vmSupported: boolean;
  vpsSupported: boolean;
  localSelectable: boolean;
  localDisabledReason: string | null;
  isLinux: boolean;
  currentTeamComputer: { id: string; name: string; botId: string; section: string } | null;
  selectedInstance: InstanceInfo | undefined;
  onUpdateComputerSelection: (patch: {
    computer?: Bot["computer"] | null;
    cloudBackend?: CloudBackend;
    browser?: boolean;
    acknowledgeLocalAuto?: boolean;
  }) => void;
  onWarnLocalAuto: (botId: string) => void;
  openVmSettings: () => void;
  botRoutines: Routine[];
  activeRoutineRun: RoutineRun | undefined;
  onSelectRoutines: () => void;
}) {
  const { state } = useStore();
  const browserAvailableHere = browserAvailable(state.config);
  // "Works on: Browser" needs the same things as the browser switch minus
  // the switch itself — picking it turns the switch on. The box-native
  // Computer engine runs inside the box, so it has no browser-only mode.
  const browserSelectable =
    builtInBrowserEnabled(state.config) &&
    browserAvailableHere &&
    selectedInstance?.capabilities?.browserMcp === true &&
    selectedInstance.driverKind !== "boxAgent";
  const browserDisabledReason = !browserAvailableHere
    ? browserUnavailableReason(state.config)
    : !builtInBrowserEnabled(state.config)
      ? t("computer.err.browserOff")
      : t("computer.err.browserEngine");

  return (
    <>
        {/* Computer source */}
          <div className="mt-4 rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">{t("computer.worksOn")}</div>
            <p className="mt-1 text-[12px] leading-5 text-ink-secondary">
              {t("computer.worksOnHint")}
            </p>
          <div role="group" aria-label={t("computer.destinationAria")} className="mt-3 grid auto-rows-fr grid-cols-2 gap-2">
            {([
              [null, "vm.dest.auto", "computer.dest.autoDesc", Sparkles],
              ["cloud", "vm.dest.cloud", "computer.dest.cloudDesc", Cloud],
              ["vm", "vm.dest.vm", "computer.dest.vmDesc", Box],
              ["local", "vm.dest.local", "computer.dest.localDesc", Monitor],
              ["browser", "vm.dest.browser", "computer.dest.browserDesc", Globe],
              ["off", "vm.dest.off", "computer.dest.offDesc", Power],
            ] as const).map(([mode, labelKey, descriptionKey, Icon]) => {
                const selected = mode === null ? !profileBot.computer : profileBot.computer === mode;
                const disabled =
                  (mode === "cloud" && !cloudSupported) ||
                  (mode === "vm" && !vmSupported) ||
                  (mode === "local" && !localSelectable) ||
                  (mode === "browser" && !browserSelectable);
                const unavailableTitle =
                  mode === "vm" && !vmSupported
                    ? t("computer.unavailableVm")
                    : mode === "cloud" && !cloudSupported
                      ? t("computer.unavailableCloud")
                      : mode === "local" && !localSelectable
                        ? localDisabledReason ?? t("computer.unavailableLocal")
                        : mode === "browser"
                          ? browserSelectable ? t("computer.browserOnlyTitle") : browserDisabledReason
                          : undefined;
                return (
              <button
                key={mode ?? "auto"}
                disabled={disabled}
                title={unavailableTitle}
                onClick={() => {
                  if ((mode === null && profileBot.computer === undefined) || mode === profileBot.computer) return;
                  if (mode === "local" && approvalModeFor(profileBot) === "auto") {
                    onWarnLocalAuto(bot.id);
                  }
                  // a browser-only bot must actually have its browser: flip
                  // the per-bot switch on with the destination
                  else if (mode === "browser") onUpdateComputerSelection({ computer: mode, browser: true });
                  else onUpdateComputerSelection({ computer: mode });
                }}
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
                  {disabled ? t("computer.unavailableHere") : t(descriptionKey)}
                </span>
              </button>
                );
            })}
          </div>
          {liveTask?.surface && (
            <p className="mt-2 text-[11.5px] leading-5 text-ink-secondary" data-testid="place-pinned-note">
              {t("place.pinnedNote", { place: t(placeLabelKey(liveTask.surface)) })}
            </p>
          )}
          {profileBot.computer === "cloud" && (
            <>
              <CloudBackendPicker
                compact
                value={cloudBackend}
                vpsSupported={vpsSupported}
                onChange={(backend) => onUpdateComputerSelection({ cloudBackend: backend })}
              />
            </>
          )}
          {profileBot.computer !== "cloud" && (
            <div className="mt-3 border-t border-hairline/40 pt-3 text-[11.5px] leading-5 text-ink-secondary" aria-live="polite">
              {!profileBot.computer ? (
                currentTeamComputer
                  ? t("computer.hint.autoTeam", { name: currentTeamComputer.name })
                  : cloudBackend === "vps" && bot.autoStartVps
                  ? t("computer.hint.vpsAuto")
                  : localSelectable && !isLinux
                    ? t("computer.hint.autoLocal")
                    : t("computer.hint.autoCloud")
              ) : profileBot.computer === "vm" ? (
                <>
                  {t("computer.hint.vm")}
                  <button type="button" onClick={openVmSettings} className="mt-1 block font-medium text-accent hover:underline">
                    {t("computer.vmSettingsLink")}
                  </button>
                </>
              ) : profileBot.computer === "local" ? (
                t("computer.hint.local")
              ) : profileBot.computer === "browser" ? (
                t("computer.hint.browser")
              ) : (
                t("computer.hint.off")
              )}
            </div>
          )}
        </div>

        {/* A compact entry beneath the computer; the tab owns the full list. */}
        <button type="button" onClick={onSelectRoutines} className="mt-4 flex w-full items-start gap-3 rounded-xl bg-card p-4 text-left hover:bg-raised">
          <CalendarClock size={17} className="mt-0.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium text-ink">{t("computer.tab.routines")} <span className="ml-1 text-[11px] text-ink-secondary">{botRoutines.length}</span></span>
            <span className={cn("mt-1 block truncate text-[11.5px]", activeRoutineRun ? routineRunTone(activeRoutineRun) : "text-ink-secondary")}>{activeRoutineRun ? `${activeRoutineRun.routineName} · ${routineRunLabel(activeRoutineRun)}` : t("computer.routines.openTitle")}</span>
          </span>
          <span className="text-ink-secondary" aria-hidden="true">→</span>
        </button>
    </>
  );
}
