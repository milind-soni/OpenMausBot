import { Plus } from "lucide-react";

import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Bot } from "@/state/store";
import { SignedInSites } from "../SignedInSites";
import { Card, ColRow, LinkRow, NoteRow } from "./rows";

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
    <Card anchor="logins">
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
          <LinkRow data-panel-action="add-login" icon={Plus} onClick={onOpenBrowser}>{t("botSettings.simple.addLogin")}</LinkRow>
        </>
      )}
    </Card>
  );
}
