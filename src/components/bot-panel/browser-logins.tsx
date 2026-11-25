import { LogIn, Plus } from "lucide-react";
import { useState } from "react";

import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { type Bot } from "@/state/store";
import { SignedInSites } from "../SignedInSites";
import { CookieImportDialog, cookieImportAvailable } from "../browser/cookie-import";
import { browserScope } from "@/lib/team-browser";
import { Card, ColRow, LinkRow, NoteRow } from "./rows";
import { sameFields, sameItems, useStoreSelector } from "@/state/store-select";

export function BrowserLogins({ bot, browserEnabled, onOpenBrowser }: {
  bot: Bot;
  browserEnabled: boolean;
  onOpenBrowser: () => void;
}) {
  const state = useStoreSelector((s) => ({ config: s.config }), sameFields);
  const [importing, setImporting] = useState(false);
  const ownerOrAdmin = useOwnerOrAdmin();
  const profileId = bot.browserProfile ?? "";
  const profile = (state.config?.browserProfiles ?? []).find((candidate) => candidate.id === profileId);
  const temporary = profileId === "guest";
  const ownChrome = profile?.browser === "chrome" && state.config?.browserEngine?.myChrome === true;
  const sharedBy = useStoreSelector((s) => profileId && !temporary
    ? s.bots.filter((candidate) => candidate.browserProfile === profileId).map((candidate) => candidate.name)
    : [bot.name], sameItems);

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
          {cookieImportAvailable(state.config) && ownerOrAdmin !== false ? (
            <>
              <LinkRow data-panel-action="import-login" icon={LogIn} onClick={() => setImporting(true)}>{t("botSettings.simple.importLogin")}</LinkRow>
              <CookieImportDialog open={importing} botId={bot.id} botName={bot.name} threadId={browserScope(state.config?.team, bot.threadId).threadId ?? null} site="" onClose={() => setImporting(false)} />
            </>
          ) : null}
        </>
      )}
    </Card>
  );
}
