import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { builtInBrowserEnabled, showToolCallsEnabled, skillAuthoringEnabled } from "@/lib/feature-flags";
import { localeChoices } from "@/locales";
import { activeLocale, activePackComplete, t } from "@/lib/i18n";
import { withTourReset } from "@/lib/guided-tour";
import { completionPatch } from "@/lib/onboarding";
import { updaterMessage, useUpdaterState } from "@/lib/updater";
import { productName } from "../lib/brand";
import { BrowserProfilesManager } from "./BrowserProfilesManager";
import { NewBrowserSettings } from "./BrowserSettingsRows";
import { SettingRow, SettingsGroup, SettingsRows, Switch } from "./SettingsPrimitives";
import { LearnedSkillsSettings } from "./ShareLearnedSkillsSettings";
import { effortLabel } from "./ModelPicker";
import { EFFORT_LEVELS, isEffortLevel } from "../../shared/wire";
import { setColorUserBubbles, useColorUserBubbles } from "@/lib/user-bubble-preference";
import { setShowThreads, useShowThreadsChoice } from "@/lib/thread-preferences";
import { setAdvancedMode, useAdvancedMode } from "@/lib/interface-mode";
import { SIMPLE_ONLY } from "@/lib/simple-only";
import { setPinnedCircles, setUniversalPins, usePinnedCircles, useUniversalPins } from "@/lib/sidebar-preferences";
import { setShowRunCard, useShowRunCard } from "@/lib/run-card-preferences";
import { parseSendKey, SEND_KEYS, sendKeyLabel, setSendKey, useSendKey } from "@/lib/send-key";
import { alternateSendLabel, parseFollowUpDefault, setFollowUpDefault, useFollowUpDefault } from "@/lib/follow-up";
import { effectiveLanguage, setLanguageChoice, useLanguageChoice } from "@/lib/language-preference";
import { Select } from "./Select";

export function UpdatesRow({ title = t("settings.updates.title") }: { title?: string }) {
  const s = useUpdaterState();
  const updater = window.ogb?.updater;
  if (!s || !updater) return null;
  const label =
    s.status === "checking"
      ? t("settings.updates.checking")
      : s.status === "downloading"
        ? s.percent == null
          ? t("settings.updates.startingDownload")
          : t("settings.updates.downloading", { percent: Math.round(s.percent) })
        : s.status === "preparing"
          ? t("settings.updates.preparing")
          : s.status === "downloaded"
            ? s.installMode === "handoff"
              ? t("settings.updates.readyInstall", { app: productName(), version: s.version ?? "" })
              : t("settings.updates.ready", { app: productName(), version: s.version ?? "" })
            : s.status === "installing"
              ? updaterMessage(s) ||
                (s.installMode === "handoff"
                  ? t("settings.updates.openingTerminal")
                  : t("settings.updates.restarting"))
              : s.status === "handed-off"
                ? t("settings.updates.handedOff")
                : s.status === "error"
                  ? t("settings.updates.failed", { message: updaterMessage(s) ?? t("settings.updates.unknownError") })
                  : t("settings.updates.latest");
  return (
    <SettingRow title={title} subtitle={label}>
      <button
        onClick={() => {
          if (s.status === "downloaded") return void updater.install();
          void updater.check();
        }}
        disabled={
          s.status === "checking" || s.status === "downloading" || s.status === "preparing" ||
          s.status === "installing" || s.retryable === false
        }
        className="ui-button"
      >
        {s.retryable === false
          ? t("settings.updates.quitReopen")
          : s.status === "downloaded"
            ? s.installMode === "handoff"
              ? t("settings.updates.install")
              : t("settings.updates.restart")
            : s.status === "preparing"
              ? t("settings.updates.preparingShort")
              : s.status === "installing"
                ? s.installMode === "handoff"
                  ? t("settings.updates.opening")
                  : t("settings.updates.restartingShort")
                : t("settings.updates.check")}
      </button>
    </SettingRow>
  );
}

function useNewBotEffort() {
  const { state, dispatch } = useStore();
  const current = state.config?.newBots?.effort ?? "";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async (value: string) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ newBots: { effort: isEffortLevel(value) ? value : null } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.newBotEffort.error"));
    } finally {
      setSaving(false);
    }
  };
  return { current, saving, error, save };
}

function NewBotEffortSelect({ effort, className }: { effort: ReturnType<typeof useNewBotEffort>; className: string }) {
  return (
    <Select size="sm" className={className}
      value={effort.current}
      disabled={effort.saving}
      aria-label={t("settings.newBotEffort.aria")}
      onChange={(event) => void effort.save(event.target.value)}
    >
      <option value="">{t("settings.newBotEffort.default")}</option>
      {EFFORT_LEVELS.map((level) => (
        <option key={level} value={level}>
          {effortLabel(level)}
        </option>
      ))}
    </Select>
  );
}

export function NewBotEffortRow() {
  const effort = useNewBotEffort();
  return (
    <SettingRow
      title={t("settings.newBotEffort.title")}
      subtitle={t("settings.newBotEffort.short")}
      message={effort.error ? <p role="alert" className="text-danger">{effort.error}</p> : null}
    >
      <NewBotEffortSelect effort={effort} className="w-full max-w-[240px]" />
    </SettingRow>
  );
}

export function NewBotDefaultsRow({ onEdit, onShare }: { onEdit: () => void; onShare: () => void }) {
  const effort = useNewBotEffort();
  return (
    <SettingRow
      title={t("newBot.defaults")}
      subtitle={t("settings.newBotEffort.title")}
      message={effort.error ? <p role="alert" className="text-danger">{effort.error}</p> : null}
    >
      <div className="flex items-center gap-2">
        <NewBotEffortSelect effort={effort} className="w-auto" />
        <button type="button" className="ui-button" data-new-bot-share onClick={onShare}>{t("newBot.sharePreset")}</button>
        <button type="button" className="ui-button" data-new-bot-defaults onClick={onEdit}>{t("newBot.edit")}</button>
      </div>
    </SettingRow>
  );
}

function ReplayAppTourButton({ label = t("settings.welcome.appTour") }: { label?: string }) {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div>
      <button
        disabled={saving}
        onClick={() => {
          setSaving(true);
          setFailed(false);
          void api("/api/config", {
            method: "PUT",
            body: JSON.stringify({ onboarding: {
              ...(!state.config?.onboarding?.completedAt ? completionPatch().onboarding : {}),
              hintsSeen: withTourReset(state.config?.onboarding),
            } }),
            signal: AbortSignal.timeout(10_000),
          })
            .then((config) => {
              dispatch({ type: "configStatus", config });
              dispatch({ type: "toggleTour", open: true });
            })
            .catch(() => setFailed(true))
            .finally(() => setSaving(false));
        }}
        className="ui-button"
      >
        {label}
      </button>
      {failed && <p role="alert" className="mt-2 text-[13px] text-danger">{t("onboarding.tour.error")}</p>}
    </div>
  );
}

/** The two tours, one row each, each with its one Replay. */
export function ReplayTourRow() {
  const { dispatch } = useStore();
  return <>
    <SettingRow title={t("settings.welcome.appTour")} subtitle={t("settings.welcome.appTourLine")}>
      <ReplayAppTourButton label={t("settings.welcome.replayShort")} />
    </SettingRow>
    <SettingRow title={t("settings.welcome.replay")} subtitle={t("settings.welcome.subtitleShort")}>
      <button type="button" onClick={() => dispatch({ type: "toggleWelcome", open: true })} className="ui-button">{t("settings.welcome.replayShort")}</button>
    </SettingRow>
  </>;
}

export function LanguageRow({ simple = false }: { simple?: boolean }) {
  const { state } = useStore();
  const current = effectiveLanguage(useLanguageChoice(), state.config?.language);

  return (
    <SettingRow
      title={t("settings.language.title")}
      subtitle={activePackComplete() ? t("settings.language.subtitleComplete") : simple ? activeLocale() === "en" ? undefined : t("settings.simple.language.partial") : t("settings.language.subtitle")}
    >
      <Select size="sm" variant={simple ? "ghost" : "field"} className={simple ? undefined : "w-full max-w-[240px]"}
        value={current}
        aria-label={t("settings.language.aria")}
        onChange={(event) => setLanguageChoice(event.target.value)}
      >
        <option value="">{t(simple ? "settings.simple.language.system" : "settings.language.system")}</option>
        {localeChoices.map(({ code, label }) => (
          <option key={code} value={code}>
            {label}
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}

export function SendKeyRow({ simple = false }: { simple?: boolean }) {
  const sendKey = useSendKey();
  return (
    <SettingRow title={t("settings.sendKey.title")} subtitle={t(simple ? "settings.simple.sendKey" : "settings.sendKey.subtitle", { key: sendKeyLabel("mod-enter") })}>
      <Select size="sm" variant={simple ? "ghost" : "field"} className={simple ? undefined : "w-full max-w-[240px]"}
        value={sendKey}
        aria-label={t("settings.sendKey.title")}
        onChange={(event) => setSendKey(parseSendKey(event.target.value))}
      >
        {SEND_KEYS.map((mode) => (
          <option key={mode} value={mode}>{sendKeyLabel(mode)}</option>
        ))}
      </Select>
    </SettingRow>
  );
}

/** What Enter does with a message sent while a bot works. A setting, not a smart default: both are right, for different people. */
export function FollowUpRow({ simple = false }: { simple?: boolean }) {
  const followUp = useFollowUpDefault();
  const key = alternateSendLabel(useSendKey());
  return (
    <SettingRow title={t("settings.followUp.title")} subtitle={t(simple ? "settings.simple.followUp" : "settings.followUp.subtitle", { key })}>
      <Select size="sm" variant={simple ? "ghost" : "field"} className={simple ? undefined : "w-full max-w-[240px]"}
        value={followUp}
        aria-label={t("settings.followUp.title")}
        onChange={(event) => setFollowUpDefault(parseFollowUpDefault(event.target.value))}
      >
        <option value="steer">{t("settings.followUp.steer")}</option>
        <option value="queue">{t("settings.followUp.queue")}</option>
      </Select>
    </SettingRow>
  );
}

export function ColorUserBubblesRow({ simple = false }: { simple?: boolean }) {
  const enabled = useColorUserBubbles();
  return (
    <SettingRow title={t(simple ? "settings.userBubbles.simpleTitle" : "settings.userBubbles.title")} subtitle={simple ? undefined : t("settings.userBubbles.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.userBubbles.aria")}
        onClick={() => setColorUserBubbles(!enabled)}
      />
    </SettingRow>
  );
}

export function AdvancedModeRow({ simple = false }: { simple?: boolean }) {
  const enabled = useAdvancedMode();
  if (SIMPLE_ONLY) return null;
  return (
    <SettingRow className={simple ? undefined : "rounded-2xl border border-accent-border/40 bg-raised-hover/40 py-4"} title={t("settings.advancedMode.title")}
      subtitle={t(simple ? "settings.simple.advancedMode" : "settings.advancedMode.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.advancedMode.title")}
        onClick={() => setAdvancedMode(!enabled)}
      />
    </SettingRow>
  );
}

export function ShowThreadsRow() {
  const enabled = useShowThreadsChoice();
  return (
    <SettingRow title={t("settings.threadDisplay.title")} subtitle={t("settings.threadDisplay.short")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.threadDisplay.show")}
        onClick={() => setShowThreads(!enabled)}
      />
    </SettingRow>
  );
}

export function PinnedCirclesRow() {
  const enabled = usePinnedCircles();
  return (
    <SettingRow title={t("settings.pinnedCircles.title")} subtitle={t("settings.pinnedCircles.short")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.pinnedCircles.title")}
        onClick={() => setPinnedCircles(!enabled)}
      />
    </SettingRow>
  );
}

export function RunCardRow() {
  const enabled = useShowRunCard();
  return (
    <SettingRow title={t("settings.runCard.title")} subtitle={t("settings.runCard.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.runCard.show")}
        onClick={() => setShowRunCard(!enabled)}
      />
    </SettingRow>
  );
}

export function UniversalPinsRow() {
  const enabled = useUniversalPins();
  return (
    <SettingRow title={t("settings.universalPins.title")} subtitle={t("settings.universalPins.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.universalPins.title")}
        onClick={() => setUniversalPins(!enabled)}
      />
    </SettingRow>
  );
}

export function ToolCallsRow() {
  const { state, dispatch } = useStore();
  const enabled = showToolCallsEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { showToolCalls: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.toolCalls.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={t("settings.toolCalls.title")}
      subtitle={t("settings.toolCalls.short")}
      message={error ? <p role="alert" className="text-danger">{error}</p> : null}
    >
      <Switch
        checked={enabled}
        aria-label={t("settings.toolCalls.aria")}
        disabled={saving}
        onClick={() => void toggle()}
        className="disabled:cursor-wait disabled:opacity-50"
      />
    </SettingRow>
  );
}

export function ExperimentalFeaturesRow() {
  const { state, dispatch } = useStore();
  const skillAuthoring = skillAuthoringEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { skillAuthoring: next } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.experimental.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup label={t("settings.experimental.title")} description={t("settings.experimental.short")} block="early-features">
      <SettingsRows>
        <SettingRow title={t("settings.experimental.skillAuthoring")} subtitle={t("settings.experimental.skillAuthoringDetail")}
          message={error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
          <Switch
            checked={skillAuthoring}
            aria-label={t("settings.experimental.skillAuthoringAria")}
            disabled={saving}
            onClick={() => void toggle(!skillAuthoring)}
            className="disabled:cursor-wait disabled:opacity-50"
          />
        </SettingRow>
        <div className="px-4 py-3 empty:hidden"><LearnedSkillsSettings /></div>
        <NewBrowserSettings />
      </SettingsRows>
    </SettingsGroup>
  );
}

export function BrowserProfilesRow() {
  const { state } = useStore();
  const profiles = state.config?.browserProfiles ?? [];
  if (!builtInBrowserEnabled(state.config) && profiles.length === 0) return null;
  return (
    <SettingsGroup label={t("settings.profiles.title")} block="profiles">
      <BrowserProfilesManager />
    </SettingsGroup>
  );
}
