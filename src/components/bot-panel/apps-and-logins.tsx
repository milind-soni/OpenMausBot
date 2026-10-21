import { Plus } from "lucide-react";

import { withBotApp } from "@/lib/bot-app-access";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Bot } from "@/state/store";
import { ServiceIcon } from "../ServiceIcon";
import { SignedInSites } from "../SignedInSites";
import type { BotApp, BotApps } from "../bot-settings/useBotApps";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { BotSwitch, Card, ColRow, LabelAction, LinkRow, NoteRow, SwitchRow, rowCls } from "./rows";

type AppsDerived = Pick<
  ReturnType<typeof useBotSettingsDerived>,
  "patch" | "canUseConnectedApps" | "connectedAppsConfigured" | "connectedAppsEnabled"
>;

export function AppsCard({ bot, derived, apps, onOpenAccess }: {
  bot: Bot;
  derived: AppsDerived;
  apps: BotApps;
  onOpenAccess: () => void;
}) {
  const { dispatch } = useStore();
  const { patch, canUseConnectedApps, connectedAppsConfigured, connectedAppsEnabled } = derived;

  const toggleApp = (app: BotApp) => {
    const connectorScopes = withBotApp(bot.connectorScopes, apps.connectedSlugs, app.slug, app.scope === null);
    if (connectorScopes) patch({ connectorScopes });
  };
  const appsNote = !canUseConnectedApps
    ? t("botSettings.simple.appsCannot", { name: bot.name })
    : apps.phase === "loading"
      ? t("common.checking")
      : apps.phase === "unknown"
        ? t("botSettings.simple.appsUnknown")
        : apps.apps.length === 0
          ? t("botSettings.simple.appsNone")
          : undefined;

  return (
    <Card label={t("botSettings.simple.apps")} anchor="apps">
      <SwitchRow
        data-panel-row="apps"
        title={t("botSettings.simple.appsAllow", { name: bot.name })}
        hint={appsNote}
        color={bot.color}
        checked={connectedAppsEnabled}
        disabled={!connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)}
        onChange={() => patch({ composio: !connectedAppsEnabled })}
      />
      {apps.apps.map((app) => (
        <div key={app.slug} data-simple-app={app.slug} className={rowCls}>
          <ServiceIcon key={`${app.card.logo}:${app.card.domain}`} card={app.card} className="size-7 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium text-ink">{app.label}</div>
            {(app.scope === "read" || app.blurb) && (
              <div className="truncate text-[12.5px] text-ink-secondary">
                {app.scope === "read" ? t("botSettings.simple.appReadOnly") : app.blurb}
              </div>
            )}
          </div>
          <BotSwitch
            color={bot.color}
            checked={app.scope !== null}
            aria-label={t("botSettings.simple.appToggle", { name: bot.name, app: app.label })}
            disabled={!connectedAppsEnabled}
            onClick={() => toggleApp(app)}
            className="disabled:cursor-not-allowed"
          />
        </div>
      ))}
      <LinkRow data-panel-link="apps" onClick={onOpenAccess}>{t("botPanel.appAccess")}</LinkRow>
      <LinkRow
        data-panel-link="add-app"
        icon={Plus}
        onClick={() => {
          dispatch({ type: "toggleSettings", open: false });
          dispatch({ type: "togglePlugins", open: true, surface: "apps" });
        }}
      >
        {t("botSettings.simple.addApp")}
      </LinkRow>
    </Card>
  );
}

export function BrowserLogins({ bot, browserEnabled, onOpenBrowser }: {
  bot: Bot;
  browserEnabled: boolean;
  onOpenBrowser: () => void;
}) {
  const { state } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const profileId = bot.browserProfile ?? "";
  const profile = (state.config?.browserProfiles ?? []).find((candidate) => candidate.id === profileId);
  const temporary = profileId === "guest";
  const ownChrome = profile?.browser === "chrome" && state.config?.browserEngine?.myChrome === true;
  const sharedBy = profileId && !temporary
    ? state.bots.filter((candidate) => candidate.browserProfile === profileId).map((candidate) => candidate.name)
    : [bot.name];

  return (
    <Card
      label={t("botSettings.simple.logins")}
      anchor="logins"
      action={<LabelAction data-panel-action="add-login" onClick={onOpenBrowser}>{t("botSettings.simple.addLogin")}</LabelAction>}
    >
      {!browserEnabled ? (
        <NoteRow>{t("botSettings.simple.loginsOff", { name: bot.name })}</NoteRow>
      ) : temporary ? (
        <NoteRow>{t("settings.profiles.temporaryHint")}</NoteRow>
      ) : ownChrome ? (
        <NoteRow>{t("settings.profiles.myChromeHint")}</NoteRow>
      ) : (
        <>
          {/* Security: reading and clearing a browser's sign-ins is the owner's or an admin's; the server refuses anyone else. */}
          {ownerOrAdmin !== false && (profileId === "" || profile) && (
            <ColRow>
              <SignedInSites bare key={`${bot.id}:${profileId}`} target={{ bot: bot.id }} sharedBy={sharedBy} disabled={Boolean(bot.busy)} />
            </ColRow>
          )}
          <NoteRow>{t("botSettings.simple.loginsHint", { name: bot.name })}</NoteRow>
        </>
      )}
    </Card>
  );
}
