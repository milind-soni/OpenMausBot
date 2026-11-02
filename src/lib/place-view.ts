import { useEffect, useState } from "react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { activeLocale, t } from "@/lib/i18n";
import { cloudPlanView } from "@/lib/cloud-plan";
import { engineSignedOut } from "@/lib/failed-turn";
import { browserAvailable, builtInBrowserEnabled, type FeatureFlagConfig } from "@/lib/feature-flags";
import { writeComputerPanelView } from "@/lib/computer-panel-view";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { openBotSettings } from "@/components/bot-panel/panel-link";
import { openKeySettings } from "@/components/keys/key-focus";
import type { Action, Bot, ConfigStatus, InstanceInfo } from "@/state/store";
import type { LocaleKey } from "@/locales";
import {
  placeRowView, placeView, type Place, type PlaceActionId, type PlaceFacts, type PlaceRow, type PlaceTranslate, type PlaceView, type ServerKind,
} from "../../shared/place-view";
import { canUseMcpServer } from "../../shared/tool-scope";

export const placeTranslate: PlaceTranslate = (key, params) => t(key as LocaleKey, params);

export interface PlaceSeat {
  server: ServerKind;
  plan: boolean;
  role: "admin" | "user";
  mode: "simple" | "advanced";
}

export function serverKind(config: Pick<ConfigStatus, "cloudHome"> | null | undefined, platform: DesktopCapabilities["host"]["platform"]): ServerKind {
  if (config?.cloudHome) return "my-cloud";
  return platform === "darwin" ? "mac" : platform === "win32" ? "pc" : "linux";
}

function engineFacts(instance: InstanceInfo | undefined, model: string | undefined): PlaceFacts["engine"] {
  const label = instance?.models?.options?.find((option) => option.id === model)?.label;
  return {
    name: instance?.displayName || instance?.driverKind || model || "",
    model: label || model || instance?.displayName || "",
    computer: instance?.capabilities?.computerMcp === true,
    browser: instance?.capabilities?.browserMcp === true,
    signedIn: !engineSignedOut(instance),
  };
}

export function placeFacts(input: {
  bot: Pick<Bot, "name" | "modelSelection" | "toolScope" | "cloudBackend">;
  place: PlaceFacts["place"];
  seat: PlaceSeat;
  config: (FeatureFlagConfig & Pick<ConfigStatus, "box">) | null | undefined;
  instances: InstanceInfo[];
  local?: PlaceFacts["local"];
  computer?: PlaceFacts["computer"];
  teamComputer?: string;
}): PlaceFacts {
  const { bot, config, seat } = input;
  const instance = input.instances.find((candidate) => candidate.instanceId === bot.modelSelection.instanceId);
  return {
    place: input.place,
    server: seat.server,
    bot: bot.name,
    plan: seat.plan,
    boat: config?.box?.configured ? (config.box.included ? "included" : "own-key") : "none",
    backend: bot.cloudBackend === "vps" ? "vps" : "box",
    engine: engineFacts(instance, bot.modelSelection.model),
    toolsAllowComputer: canUseMcpServer(bot.toolScope, "computer"),
    browserOn: builtInBrowserEnabled(config) && browserAvailable(config),
    role: seat.role,
    mode: seat.mode,
    ...(input.local ? { local: input.local } : {}),
    ...(input.computer ? { computer: input.computer } : {}),
    ...(input.teamComputer ? { teamComputer: input.teamComputer } : {}),
  };
}

export function placeViewFor(facts: PlaceFacts): PlaceView {
  return placeView(facts, { translate: placeTranslate, locale: activeLocale() });
}

export function placeRowViewFor(row: PlaceRow, seat: PlaceSeat, worksOnLabel?: string): PlaceView {
  const read = row.state === "cc-needs-key" && seat.plan && seat.server !== "my-cloud" ? { ...row, state: "cc-on-my-cloud" as const } : row;
  return placeRowView(read, { server: seat.server, role: seat.role, mode: seat.mode, worksOnLabel, translate: placeTranslate, locale: activeLocale() });
}

export function placeBlocked(view: PlaceView): boolean {
  return view.state === "cc-cannot" || view.state === "cc-on-my-cloud" || view.state === "browser-off" || view.state === "browser-cannot"
    || view.state === "vm-cannot" || view.state === "local-unavailable";
}

export function placeHasIssue(view: PlaceView): boolean {
  return placeBlocked(view) || view.state === "cc-tools-off" || view.state === "cc-sign-in" || view.state === "cc-needs-key"
    || view.state === "cc-unavailable";
}

export function useCloudPlanPaid(): boolean {
  const bridge = typeof window === "undefined" || window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState((next) => { updated = true; if (active) setAccount(next); });
    void bridge.state().then((next) => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return Boolean(bridge) && cloudPlanView(account).kind === "paid";
}

export function usePlaceSeat(config: Pick<ConfigStatus, "cloudHome"> | null | undefined, platform: DesktopCapabilities["host"]["platform"]): PlaceSeat {
  const plan = useCloudPlanPaid();
  const ownerOrAdmin = useOwnerOrAdmin();
  const advanced = useAdvancedMode();
  return { server: serverKind(config, platform), plan, role: ownerOrAdmin === false ? "user" : "admin", mode: advanced ? "advanced" : "simple" };
}

export function openPlaceAction(
  id: PlaceActionId,
  target: { botId: string; threadId?: string; place?: Place },
  dispatch: (action: Action) => void,
): boolean {
  const appSettings = (section: "engines" | "computer" | "cloudAccount") =>
    dispatch({ type: "toggleAppSettings", open: true, section });
  switch (id) {
    case "choose-model": openBotSettings(dispatch, "model", { botId: target.botId }); return true;
    case "open-tools": openBotSettings(dispatch, "access", { botId: target.botId, page: "tools" }); return true;
    case "change-routine": openBotSettings(dispatch, "routines", { botId: target.botId }); return true;
    case "sign-in": appSettings("engines"); return true;
    case "manage-computers": appSettings("computer"); return true;
    case "add-boat-key": dispatch(openKeySettings("box")); return true;
    case "open-vm-settings":
      window.sessionStorage?.setItem("openmausbot.settings.section", "computer");
      appSettings("computer");
      return true;
    case "open-team-map": dispatch({ type: "showTeamMap" }); return true;
    case "see-plan": {
      const desktop = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
      if (desktop) { void desktop.openDashboard().catch(() => {}); return true; }
      if (window.ogb?.cloudPlan) { void window.ogb.cloudPlan.manage().catch(() => {}); return true; }
      appSettings("cloudAccount");
      return true;
    }
    case "open-my-cloud": {
      const desktop = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
      if (desktop) void desktop.connectHome().catch(() => {});
      else appSettings("cloudAccount");
      return true;
    }
    case "clear-pin":
      if (!target.threadId) return false;
      dispatch({ type: "updateTask", botId: target.botId, threadId: target.threadId, patch: { surface: null } });
      return true;
    case "watch":
    case "open-computer-panel":
    case "turn-on-browser":
      writeComputerPanelView(target.botId, id === "turn-on-browser" ? "browser" : "computer");
      dispatch({ type: "toggleComputer", open: true });
      return true;
    default:
      return false;
  }
}

export const SIMPLE_PLACE_LABEL = {
  auto: "vm.dest.auto",
  cloud: "place.cloud",
  vm: "vm.dest.vm",
  browser: "vm.dest.browser",
  off: "vm.dest.off",
} as const satisfies Record<string, LocaleKey>;

export function worksOnSimpleLabel(computer: Bot["computer"], platform: DesktopCapabilities["host"]["platform"]): string {
  if (computer === "local") return t(platform === "darwin" ? "computer.simple.dest.thisMac" : "computer.simple.dest.thisPc");
  return t(SIMPLE_PLACE_LABEL[computer ?? "auto"]);
}
