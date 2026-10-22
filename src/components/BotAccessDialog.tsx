import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Copy, X } from "lucide-react";

import { approvalModeOptions, approvalModeOptionsFor } from "@/lib/approval-mode-options";
import {
  accessBots,
  appAccess,
  appAccessPatch,
  outboundOf,
  outboundPatch,
  planAppForAll,
  planApprovalForAll,
  planCopyAccess,
  planOutboundForAll,
  type AppAccess,
  type AppAccessChoice,
} from "@/lib/bot-access-matrix";
import { connectorServiceAccess } from "@/lib/connector-grants";
import { t } from "@/lib/i18n";
import {
  applyTeamPlan,
  planNeedsLocalAutoConsent,
  TEAM_APPROVAL_MODES,
  teamResultCounts,
  type TeamApprovalMode,
  type TeamPlanRow,
  type TeamResultRow,
} from "@/lib/team-bulk-settings";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, desktopApprovalBridge, persistBotUpdate, useStore, type Bot } from "@/state/store";
import type { BotUpdatePatch } from "@/state/bot-patch-queue";
import { approvalModeFor } from "../../shared/approval-mode";
import type { OutboundPolicy } from "../../shared/outbound";
import { BotAvatar } from "./Avatar";
import { openBotSettings } from "./bot-panel/panel-link";
import { useConnectedApps, type BotApp } from "./bot-settings/useBotApps";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { ServiceIcon } from "./PluginsPanel";
import { Select } from "./Select";
import { TeamSettingsRows } from "./TeamSettingsDialog";

const SET_ALL = "";
const CHOICES: ReadonlyArray<readonly [AppAccessChoice, Parameters<typeof t>[0]]> = [
  ["all", "botAccessMatrix.app.all"],
  ["read", "botAccessMatrix.app.read"],
  ["none", "botAccessMatrix.app.none"],
];

interface Bulk {
  title: string;
  plan: TeamPlanRow[];
}

export function BotAccessDialog({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const readOnly = ownerOrAdmin === false;
  const trustedModesAvailable = desktopApprovalBridge() !== undefined;
  const connected = useConnectedApps();
  const bots = useMemo(() => accessBots(state.bots), [state.bots]);
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<TeamResultRow[] | null>(null);
  const [consent, setConsent] = useState<null | { kind: "bulk" } | { kind: "one"; botId: string; patch: BotUpdatePatch }>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  const save = (bot: Bot, patch: BotUpdatePatch | null) => {
    if (patch) dispatch({ type: "updateBot", botId: bot.id, patch });
  };
  const setApproval = (bot: Bot, mode: TeamApprovalMode) => {
    const [row] = planApprovalForAll([bot], state.instances, mode);
    if (row?.status !== "apply") return;
    if (planNeedsLocalAutoConsent([row])) setConsent({ kind: "one", botId: bot.id, patch: row.patch });
    else save(bot, row.patch);
  };
  const startBulk = (title: string, plan: TeamPlanRow[]) => {
    setResults(null);
    setBulk({ title, plan });
  };
  const runBulk = async (acknowledgeLocalAuto: boolean) => {
    if (!bulk || running) return;
    setRunning(true);
    setProgress(0);
    const outcome = await applyTeamPlan(bulk.plan, async (bot, patch) => {
      const saved = await persistBotUpdate(bot.id, patch, new AbortController().signal, api, desktopApprovalBridge(), bot);
      dispatch({ type: "botPatched", bot: saved });
    }, { acknowledgeLocalAuto, onProgress: setProgress });
    setResults(outcome);
    setRunning(false);
  };
  const confirmBulk = () => {
    if (!bulk) return;
    if (planNeedsLocalAutoConsent(bulk.plan)) setConsent({ kind: "bulk" });
    else void runBulk(false);
  };
  const leaveBulk = () => {
    if (running) return;
    setBulk(null);
    setResults(null);
  };
  const close = () => { if (!running) onClose(); };
  const applying = bulk?.plan.filter((row) => row.status === "apply").length ?? 0;
  const counts = results ? teamResultCounts(results) : null;
  const apps = connected.apps;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="bot-access-title" data-testid="bot-access-dialog"
        className="flex max-h-[90vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel text-ink shadow-2xl"
        onKeyDown={(event) => {
          if (consent) return;
          if (event.key === "Tab") {
            trapTab(event, dialog.current);
            return;
          }
          if (event.key !== "Escape") return;
          event.stopPropagation();
          if (bulk) leaveBulk();
          else close();
        }}>
        <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
          <div className="min-w-0">
            <h2 id="bot-access-title" className="text-[17px] font-semibold">{bulk ? bulk.title : t("botAccessMatrix.title")}</h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">
              {bulk ? t("botAccessMatrix.bulk.intro") : t("botAccessMatrix.subtitle")}
            </p>
          </div>
          <button type="button" aria-label={t("botAccessMatrix.close")} disabled={running} onClick={close}
            className="shrink-0 rounded-lg p-1.5 text-ink-secondary hover:bg-raised"><X size={18} /></button>
        </div>

        {bulk ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            {results && counts && (
              <p role="status" className="mb-3 text-[13px] text-ink-secondary">
                {t("teamSettings.summary", { applied: counts.applied, unchanged: counts.unchanged, skipped: counts.skipped })}
              </p>
            )}
            <TeamSettingsRows rows={results ?? bulk.plan} />
            <div className="mt-4 flex items-center justify-end gap-2">
              {running && <span role="status" className="mr-auto text-[12px] text-ink-secondary">{t("teamSettings.progress", { done: progress, count: bulk.plan.length })}</span>}
              {results ? (
                <button type="button" onClick={leaveBulk} className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white">{t("botAccessMatrix.bulk.back")}</button>
              ) : (
                <>
                  <button type="button" disabled={running} onClick={leaveBulk} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised">{t("common.cancel")}</button>
                  <button type="button" disabled={running || !applying} onClick={confirmBulk}
                    className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40">
                    {t(applying === 1 ? "teamSettings.applyOne" : "teamSettings.applyMany", { count: applying })}
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
            {readOnly && <p role="note" className="mb-3 rounded-lg bg-inset px-3 py-2 text-[12.5px] text-ink-secondary">{t("botAccessMatrix.readOnly")}</p>}
            {connected.phase === "unknown" && <p role="note" className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-[12.5px] text-warning">{t("botAccessMatrix.appsUnknown")}</p>}
            {bots.length === 0 ? (
              <p className="rounded-lg bg-inset px-3 py-2 text-[13px] text-ink-secondary">{t("botAccessMatrix.noBots")}</p>
            ) : (
              <table className="w-full border-separate border-spacing-0 text-[13px]" data-testid="bot-access-matrix">
                <thead>
                  <tr className="align-bottom">
                    <th scope="col" className="sticky left-0 z-10 bg-panel px-2 pb-2 text-left text-[12px] font-medium text-ink-secondary">{t("botAccessMatrix.column.bot")}</th>
                    {apps.map((app) => (
                      <th key={app.slug} scope="col" className="min-w-[132px] px-2 pb-2 text-left font-medium">
                        <AppHeading app={app} />
                        <Select size="sm" className="mt-1.5 w-full" aria-label={t("botAccessMatrix.setAllFor", { name: app.label })}
                          disabled={readOnly} value={SET_ALL}
                          onChange={(event) => {
                            const choice = event.target.value as AppAccessChoice;
                            const label = t(CHOICES.find(([value]) => value === choice)![1]);
                            startBulk(t("botAccessMatrix.bulk.app", { app: app.label, choice: label }),
                              planAppForAll(bots, state.instances, app.slug, choice, connected.connectedSlugs));
                          }}>
                          <option value={SET_ALL} disabled>{t("botAccessMatrix.setAll")}</option>
                          {CHOICES.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
                        </Select>
                      </th>
                    ))}
                    <th scope="col" className="min-w-[150px] px-2 pb-2 text-left font-medium">
                      <span className="text-[12.5px]">{t("botAccessMatrix.column.approval")}</span>
                      <Select size="sm" className="mt-1.5 w-full" aria-label={t("botAccessMatrix.setAllApproval")}
                        disabled={readOnly} value={SET_ALL}
                        onChange={(event) => {
                          const mode = event.target.value as TeamApprovalMode;
                          const label = approvalModeOptions().find((option) => option.mode === mode)?.label ?? mode;
                          startBulk(t("botAccessMatrix.bulk.approval", { level: label }), planApprovalForAll(bots, state.instances, mode));
                        }}>
                        <option value={SET_ALL} disabled>{t("botAccessMatrix.setAll")}</option>
                        {approvalModeOptions().filter((option) => (TEAM_APPROVAL_MODES as readonly string[]).includes(option.mode))
                          .map((option) => <option key={option.mode} value={option.mode}>{option.label}</option>)}
                      </Select>
                    </th>
                    <th scope="col" className="min-w-[132px] px-2 pb-2 text-left font-medium">
                      <span className="text-[12.5px]">{t("botAccessMatrix.column.sending")}</span>
                      <Select size="sm" className="mt-1.5 w-full" aria-label={t("botAccessMatrix.setAllSending")}
                        disabled={readOnly} value={SET_ALL}
                        onChange={(event) => {
                          const policy = event.target.value as OutboundPolicy["policy"];
                          startBulk(t("botAccessMatrix.bulk.sending", { rule: t(policy === "ask" ? "permissions.outbound.ask" : "permissions.outbound.allow") }),
                            planOutboundForAll(bots, policy));
                        }}>
                        <option value={SET_ALL} disabled>{t("botAccessMatrix.setAll")}</option>
                        <option value="ask">{t("permissions.outbound.ask")}</option>
                        <option value="allow">{t("permissions.outbound.allow")}</option>
                      </Select>
                    </th>
                    <th scope="col" className="px-2 pb-2"><span className="sr-only">{t("botAccessMatrix.column.actions")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {bots.map((bot) => {
                    const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
                    const mode = approvalModeFor(bot);
                    const engineOptions = approvalModeOptionsFor(engine?.driverKind ?? "", trustedModesAvailable)
                      .filter((option) => option.mode === mode || (TEAM_APPROVAL_MODES as readonly string[]).includes(option.mode));
                    const offered = engineOptions.some((option) => option.mode === mode) ? engineOptions
                      : [...approvalModeOptions().filter((option) => option.mode === mode), ...engineOptions];
                    const busy = Boolean(bot.busy || bot.tasks?.some((task) => task.busy));
                    return (
                      <tr key={bot.id} data-bot-id={bot.id} className="group">
                        <th scope="row" className="sticky left-0 z-10 border-t border-hairline/40 bg-panel px-2 py-2 text-left font-normal">
                          <button type="button" title={t("botAccessMatrix.openSettings", { name: bot.name })}
                            onClick={() => {
                              onClose();
                              dispatch({ type: "togglePlugins", open: false });
                              openBotSettings(dispatch, "access", { botId: bot.id, page: "apps" });
                            }}
                            className="flex max-w-[180px] items-center gap-2 rounded-md text-left hover:text-accent-text">
                            <BotAvatar bot={bot} size={22} />
                            <span className="min-w-0 truncate">{bot.name}</span>
                          </button>
                        </th>
                        {apps.map((app) => (
                          <td key={app.slug} className="border-t border-hairline/40 px-2 py-2">
                            <AppCell access={appAccess(bot, state.instances, app.slug)} bot={bot} app={app} disabled={readOnly}
                              count={countFor(bot, app.slug)}
                              onPick={(choice) => save(bot, appAccessPatch(bot, state.instances, app.slug, choice, connected.connectedSlugs))} />
                          </td>
                        ))}
                        <td className="border-t border-hairline/40 px-2 py-2">
                          <Select size="sm" className="w-full" aria-label={t("botAccessMatrix.approvalFor", { name: bot.name })}
                            value={mode} disabled={readOnly || busy}
                            title={busy ? t("teamSettings.skip.busy") : undefined}
                            onChange={(event) => setApproval(bot, event.target.value as TeamApprovalMode)}>
                            {offered.map((option) => (
                              <option key={option.mode} value={option.mode}
                                disabled={!(TEAM_APPROVAL_MODES as readonly string[]).includes(option.mode)}>{option.label}</option>
                            ))}
                          </Select>
                        </td>
                        <td className="border-t border-hairline/40 px-2 py-2">
                          <Select size="sm" className="w-full" aria-label={t("botAccessMatrix.sendingFor", { name: bot.name })}
                            value={outboundOf(bot).policy} disabled={readOnly}
                            onChange={(event) => save(bot, outboundPatch(bot, event.target.value as OutboundPolicy["policy"]))}>
                            <option value="ask">{t("permissions.outbound.ask")}</option>
                            <option value="allow">{t("permissions.outbound.allow")}</option>
                          </Select>
                        </td>
                        <td className="border-t border-hairline/40 px-2 py-2 text-right">
                          <button type="button" disabled={readOnly || bots.length < 2}
                            title={t("botAccessMatrix.copyHint", { name: bot.name })}
                            aria-label={t("botAccessMatrix.copyHint", { name: bot.name })}
                            onClick={() => startBulk(t("botAccessMatrix.bulk.copy", { name: bot.name }), planCopyAccess(bot, bots, state.instances))}
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">
                            <Copy size={13} aria-hidden="true" /> {t("botAccessMatrix.copy")}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {connected.phase === "ready" && apps.length === 0 && (
              <p className="mt-3 text-[12.5px] text-ink-secondary">{t("botAccessMatrix.noApps")}</p>
            )}
            <p className="mt-4 text-[12px] leading-relaxed text-ink-secondary">{t("botAccessMatrix.footnote")}</p>
          </div>
        )}
      </div>
      <LocalComputerAutoWarning
        open={consent !== null}
        onCancel={() => setConsent(null)}
        onConfirm={() => {
          const pending = consent;
          setConsent(null);
          if (pending?.kind === "bulk") void runBulk(true);
          else if (pending?.kind === "one") {
            dispatch({ type: "updateBot", botId: pending.botId, patch: { ...pending.patch, acknowledgeLocalAuto: true } });
          }
        }}
      />
    </div>, document.body,
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (!container) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.getClientRects().length > 0);
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  if (!items.some((element) => element === active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function countFor(bot: Bot, slug: string): number {
  return connectorServiceAccess(bot.connectorTools, slug).count;
}

function AppHeading({ app }: { app: BotApp }) {
  return (
    <span className="flex items-center gap-1.5">
      <ServiceIcon card={app.card} className="size-5 rounded-md" />
      <span className="min-w-0 truncate text-[12.5px]" title={app.label}>{app.label}</span>
    </span>
  );
}

function AppCell({ access, bot, app, count, disabled, onPick }: {
  access: AppAccess;
  bot: Bot;
  app: BotApp;
  count: number;
  disabled: boolean;
  onPick: (choice: AppAccessChoice) => void;
}) {
  if (access === "unsupported") {
    return <span className="text-ink-secondary" title={t("botAccessMatrix.cell.unsupportedHint")}>{t("botAccessMatrix.cell.unsupported")}</span>;
  }
  if (access === "custom") {
    return <span className="text-warning" title={t("botAccessMatrix.cell.customHint")}>{t("botAccessMatrix.cell.custom")}</span>;
  }
  return (
    <Select size="sm" className="w-full" value={access} disabled={disabled}
      aria-label={t("botAccessMatrix.cellLabel", { name: bot.name, app: app.label })}
      onChange={(event) => onPick(event.target.value as AppAccessChoice)}>
      {access === "some" && <option value="some" disabled>{t("botAccessMatrix.app.some", { count })}</option>}
      {CHOICES.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
    </Select>
  );
}
