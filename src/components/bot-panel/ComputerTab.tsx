import { useEffect, useState } from "react";
import { KeyRound, Monitor } from "lucide-react";

import { writeComputerPanelView, type ComputerPanelView } from "@/lib/computer-panel-view";
import { t } from "@/lib/i18n";
import type { Place } from "@/lib/place";
import { placeHasIssue, worksOnSimpleLabel } from "@/lib/place-view";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, useStore, type Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { usePlaceViews } from "../PlaceChip";
import { screenFramePreview } from "../ScreenFrame";
import type { BotPatch, useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import type { SimplePageId } from "./page-registry";
import { Card, ColRow, NavRow, RowText, Segmented, type SegmentOption } from "./rows";

type Derived = ReturnType<typeof useBotSettingsDerived>;
type PlaceChoice = "auto" | Place | "off";

const EXTRA_PLACE_LABEL: Record<Exclude<PlaceChoice, "auto" | "local" | "cloud" | "browser">, () => string> = {
  vm: () => t("place.vm"),
  off: () => t("place.off"),
};

export function useOpenComputer(bot: Pick<Bot, "id">) {
  const { dispatch } = useStore();
  return (view: ComputerPanelView = "computer") => {
    writeComputerPanelView(bot.id, view);
    dispatch({ type: "toggleSettings", open: false });
    dispatch({ type: "toggleComputer", open: true });
  };
}

/** How many sites the bot's own browser is signed in to; null until read, and never asked for by a non-owner. */
function useSignedInCount(bot: Pick<Bot, "id">, enabled: boolean): number | null {
  const [count, setCount] = useState<{ botId: string; count: number } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void api(`/api/browser-sites?bot=${encodeURIComponent(bot.id)}`)
      .then((answer: { sites?: unknown[] }) => { if (!cancelled) setCount({ botId: bot.id, count: answer.sites?.length ?? 0 }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [bot.id, enabled]);
  return count?.botId === bot.id ? count.count : null;
}

export function ComputerTab({ bot, derived, onOpen }: { bot: Bot; derived: Derived; onOpen: (page: SimplePageId) => void }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const platform = capabilities.host?.platform ?? "other";
  const placeViews = usePlaceViews(bot);
  const openComputer = useOpenComputer(bot);
  const ownerOrAdmin = useOwnerOrAdmin();
  const [localAutoWarning, setLocalAutoWarning] = useState<{ botId: string; patch: BotPatch } | null>(null);
  const { patch, approvalMode, browserEnabled } = derived;
  const signedIn = useSignedInCount(bot, browserEnabled && bot.computer !== "off" && ownerOrAdmin !== false);

  const currentPlace: PlaceChoice = bot.computer ?? "auto";
  const myChrome = state.config?.browserEngine?.myChrome === true
    && (state.config?.browserProfiles ?? []).some((profile) => profile.id === bot.browserProfile && profile.browser === "chrome");
  const placeLabel = (place: Place) => (place === "browser" && myChrome ? t("settings.profiles.myChrome") : worksOnSimpleLabel(place, platform));
  const choice = (place: Place): SegmentOption<PlaceChoice> => {
    const { view, reachable } = placeViews[place];
    return { value: place, label: placeLabel(place), disabled: !reachable, tooltip: !reachable || placeHasIssue(view) ? view.line : undefined };
  };
  const options: SegmentOption<PlaceChoice>[] = [
    { value: "auto", label: t("computer.simple.dest.letItChoose") },
    ...(placeViews.local.policy ? [choice("local")] : []),
    ...(placeViews.browser.policy || currentPlace === "browser" ? [choice("browser")] : []),
    ...(placeViews.cloud.policy ? [choice("cloud")] : []),
    ...(currentPlace === "vm" || currentPlace === "off"
      ? [{ value: currentPlace, label: EXTRA_PLACE_LABEL[currentPlace](), disabled: true }]
      : []),
  ];
  const choosePlace = (value: PlaceChoice) => {
    if (value === currentPlace || value === "vm" || value === "off") return;
    if (value === "local" && approvalMode === "auto") {
      setLocalAutoWarning({ botId: bot.id, patch: { computer: "local", acknowledgeLocalAuto: true } });
      return;
    }
    patch(value === "browser" ? { computer: "browser", browser: true } : { computer: value === "auto" ? null : value });
  };
  const liveSurface = bot.tasks?.find((task) => task.threadId === bot.threadId)?.surface;
  const usingNow = liveSurface && liveSurface !== currentPlace ? placeLabel(liveSurface) : null;

  const screen = [...bot.messages].reverse().find((message) => message.kind === "screen" && (message.hasImage || message.png));
  const screenSrc = screen ? screenFramePreview({ threadId: bot.threadId, messageId: screen.id }, screen.mime).src : null;

  return (
    <div data-panel-tabpanel="computer">
      <div className="relative mt-[18px] flex aspect-[16/10] max-w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-ink/[0.06] bg-inset">
        {screenSrc ? (
          <img src={screenSrc} alt={t("computer.screenOf", { name: bot.name })} className="absolute inset-0 size-full object-cover" />
        ) : (
          <>
            <span className="opacity-55"><BotAvatar bot={bot} size={52} animated={false} /></span>
            <span className="max-w-[80%] text-center text-[13px] text-ink-secondary">{t(bot.busy ? "botPanel.screen.working" : "botPanel.screen.idle")}</span>
          </>
        )}
        <button
          type="button"
          data-panel-action="open-computer"
          onClick={() => openComputer()}
          className="absolute bottom-2.5 right-2.5 flex h-7 items-center gap-1.5 rounded-full border border-ink/10 bg-panel/80 px-2.5 text-[12px] text-ink backdrop-blur-sm hover:bg-panel"
        >
          <Monitor size={13} aria-hidden="true" />
          {t("place.action.watch")}
        </button>
      </div>
      <div className="mt-[7px] text-center text-[12px] text-ink-tertiary">{t("computer.screenOf", { name: bot.name })}</div>

      <Card anchor="where">
        <ColRow data-panel-row="where">
          <RowText
            title={t("computer.simple.whereWorks", { name: bot.name })}
            hint={usingNow ? t("computer.simple.usingNow", { place: usingNow }) : undefined}
          />
          <Segmented
            attr="data-place-choice"
            label={t("computer.simple.whereWorks", { name: bot.name })}
            value={currentPlace}
            onChange={choosePlace}
            options={options}
          />
        </ColRow>
      </Card>

      <Card anchor="logins">
        <NavRow
          data-panel-page="browser"
          icon={KeyRound}
          title={t("settings.sites.title")}
          value={signedIn ?? undefined}
          onClick={() => onOpen("browser")}
        />
      </Card>

      <LocalComputerAutoWarning
        open={localAutoWarning !== null}
        onCancel={() => setLocalAutoWarning(null)}
        onConfirm={() => {
          const target = localAutoWarning;
          setLocalAutoWarning(null);
          if (!target) return;
          dispatch({ type: "updateBot", botId: target.botId, patch: target.patch });
        }}
      />
    </div>
  );
}
