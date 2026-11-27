import { useEffect, useState } from "react";

import type { BotTasksSettings } from "../../../../shared/bot-tasks";
import { botTasksPatchBody, botTasksStatus, parseRepos, pollMinutesValue, type BotTasksPatch, type BotTasksStatus } from "@/lib/bot-tasks";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { api, type ConfigStatus } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import {
  Segmented, SETTINGS_INLINE_INPUT, SETTINGS_INPUT, SettingRow, SettingsField, SettingsFormFoot, SettingsGroup, SettingsRows, StatusDot, Switch,
} from "../../SettingsPrimitives";

type Field = keyof BotTasksPatch;
type SwitchName = { [K in keyof BotTasksSettings]: BotTasksSettings[K] extends boolean ? K : never }[keyof BotTasksSettings];

export interface BotTasksSettingsViewProps {
  settings: BotTasksStatus;
  /** Resolves once the server took the change; throws when it didn't. */
  save: (patch: BotTasksPatch) => Promise<void>;
}

const SWITCH_COPY: Record<SwitchName, { title: LocaleKey; line: LocaleKey }> = {
  enabled: { title: "settings.botTasks.enabled", line: "settings.botTasks.enabledLine" },
  githubSync: { title: "settings.botTasks.githubSync", line: "settings.botTasks.githubSyncLine" },
  requireEvidenceForDone: { title: "settings.botTasks.evidenceDone", line: "settings.botTasks.evidenceDoneLine" },
  requireEvidenceForReview: { title: "settings.botTasks.evidenceReview", line: "settings.botTasks.evidenceReviewLine" },
  allowOutboundComments: { title: "settings.botTasks.outbound", line: "settings.botTasks.outboundLine" },
  allowMerge: { title: "settings.botTasks.merge", line: "settings.botTasks.mergeLine" },
};

const ErrorLine = ({ text }: { text: string }) => <span role="alert" className="text-danger">{text}</span>;

/** Bot tasks' settings, drawn from what the server says and saved one change at a time. */
export function BotTasksSettingsView({ settings, save }: BotTasksSettingsViewProps) {
  const [pending, setPending] = useState<Field | null>(null);
  const [failed, setFailed] = useState<Field | null>(null);
  const [poll, setPoll] = useState(String(settings.pollMinutes));
  const [repoText, setRepoText] = useState(settings.repos.join("\n"));
  const [token, setToken] = useState("");
  useEffect(() => setPoll(String(settings.pollMinutes)), [settings.pollMinutes]);
  useEffect(() => setRepoText(settings.repos.join("\n")), [settings.repos]);

  const send = async (field: Field, patch: BotTasksPatch): Promise<boolean> => {
    if (pending) return false;
    setPending(field);
    setFailed(null);
    try {
      await save(patch);
      return true;
    } catch {
      setFailed(field);
      return false;
    } finally {
      setPending(null);
    }
  };
  const errorFor = (field: Field) => (failed === field ? <ErrorLine text={t("settings.botTasks.saveFailed")} /> : null);

  const on = settings.enabled;
  const sync = on && settings.githubSync;
  const toggle = (name: SwitchName, enabledHere: boolean, reason?: LocaleKey) => {
    const copy = SWITCH_COPY[name];
    return (
      <SettingRow title={t(copy.title)} subtitle={t(copy.line)} message={errorFor(name) ?? (!enabledHere && reason ? t(reason) : null)}>
        <Switch data-bot-tasks-switch={name} checked={settings[name]} aria-label={t(copy.title)} disabled={!enabledHere || pending !== null}
          onClick={() => void send(name, { [name]: !settings[name] })} />
      </SettingRow>
    );
  };

  const pollValue = pollMinutesValue(poll);
  const savePoll = () => {
    if (pollValue === null) { setPoll(String(settings.pollMinutes)); return; }
    if (pollValue !== settings.pollMinutes) void send("pollMinutes", { pollMinutes: pollValue });
  };
  const parsed = parseRepos(repoText);
  const reposChanged = parsed.repos.join("\n") !== settings.repos.join("\n");
  const saveToken = async (value: string | null) => { if (await send("githubToken", { githubToken: value })) setToken(""); };

  return (
    <div className="flex flex-col gap-6" data-bot-tasks-settings="">
      <SettingsGroup block="bot-tasks">
        <SettingsRows>{toggle("enabled", true)}</SettingsRows>
      </SettingsGroup>

      <SettingsGroup block="bot-tasks-github" label={t("settings.botTasks.github")}>
        <SettingsRows selectWidth={200}>
          {toggle("githubSync", on, "settings.botTasks.needsEnabled")}
          <SettingRow title={t("settings.botTasks.poll")} subtitle={t("settings.botTasks.pollLine")}
            message={errorFor("pollMinutes") ?? (poll.trim() && pollValue === null ? <ErrorLine text={t("settings.botTasks.pollInvalid")} /> : null)}>
            <input type="text" inputMode="numeric" value={poll} aria-label={t("settings.botTasks.poll")} disabled={!sync || pending !== null}
              data-bot-tasks-poll="" onChange={(event) => setPoll(event.target.value)} onBlur={savePoll}
              onKeyDown={(event) => { if (event.key === "Enter") savePoll(); }} className={SETTINGS_INLINE_INPUT} />
          </SettingRow>
          <div className="flex flex-col gap-2 px-4 pb-1 pt-3" data-bot-tasks-repos="">
            <SettingsField label={t("settings.botTasks.repos")} hint={settings.repos.length ? t("settings.botTasks.reposLine") : t("settings.botTasks.reposEmpty")}>
              <textarea value={repoText} rows={3} disabled={!sync || pending !== null} spellCheck={false} autoComplete="off" dir="ltr"
                placeholder="owner/repo" onChange={(event) => setRepoText(event.target.value)}
                className={`${SETTINGS_INPUT} h-auto min-h-20 resize-y py-1.5`} />
            </SettingsField>
          </div>
          <SettingsFormFoot status={errorFor("repos") ?? (parsed.invalid.length
            ? <ErrorLine text={t("settings.botTasks.reposInvalid", { repos: parsed.invalid.join(", ") })} />
            : t("settings.botTasks.reposCount", { count: parsed.repos.length }))}>
            <button type="button" data-bot-tasks-save-repos="" className="ui-button ui-button-md rounded-full"
              disabled={!sync || pending !== null || !reposChanged || parsed.invalid.length > 0}
              onClick={() => void send("repos", { repos: parsed.repos })}>
              {pending === "repos" ? t("common.saving") : t("common.save")}
            </button>
          </SettingsFormFoot>
          <SettingRow title={t("settings.botTasks.credential")} message={errorFor("credential")}>
            <Segmented label={t("settings.botTasks.credential")} value={settings.credential} disabled={!sync || pending !== null}
              options={[{ value: "gh", label: t("settings.botTasks.credentialGh") }, { value: "vault", label: t("settings.botTasks.credentialVault") }]}
              onChange={(credential) => { if (credential !== settings.credential) void send("credential", { credential }); }} />
          </SettingRow>
          {settings.credential === "vault" && (
            <>
              <div className="flex flex-col gap-2 px-4 pb-1 pt-3" data-bot-tasks-token="">
                <SettingsField label={t("settings.botTasks.token")} hint={t("settings.botTasks.tokenLine")}>
                  <input type="password" value={token} autoComplete="off" spellCheck={false} disabled={!sync || pending !== null}
                    placeholder={settings.githubTokenSet ? t("settings.botTasks.tokenReplace") : t("settings.botTasks.tokenPlaceholder")}
                    onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && token.trim()) void saveToken(token.trim()); }}
                    className={SETTINGS_INPUT} />
                </SettingsField>
              </div>
              <SettingsFormFoot status={errorFor("githubToken") ?? (
                <span role="status" data-bot-tasks-token-state={settings.githubTokenSet ? "set" : "unset"} className="flex items-center">
                  <StatusDot tone={settings.githubTokenSet ? "success" : null} />
                  {settings.githubTokenSet ? t("settings.botTasks.tokenSet") : t("settings.botTasks.tokenUnset")}
                </span>
              )}>
                {settings.githubTokenSet && (
                  <button type="button" data-bot-tasks-clear-token="" className="ui-button ui-button-md rounded-full" disabled={!sync || pending !== null}
                    onClick={() => void saveToken(null)}>{t("settings.botTasks.tokenRemove")}</button>
                )}
                <button type="button" data-bot-tasks-save-token="" className="ui-button ui-button-md rounded-full" disabled={!sync || pending !== null || !token.trim()}
                  onClick={() => void saveToken(token.trim())}>{pending === "githubToken" ? t("common.saving") : t("common.save")}</button>
              </SettingsFormFoot>
            </>
          )}
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup block="bot-tasks-proof" label={t("settings.botTasks.proof")}>
        <SettingsRows>
          {toggle("requireEvidenceForDone", on, "settings.botTasks.needsEnabled")}
          {toggle("requireEvidenceForReview", on, "settings.botTasks.needsEnabled")}
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup block="bot-tasks-posting" label={t("settings.botTasks.posting")}>
        <SettingsRows>
          {toggle("allowOutboundComments", sync, "settings.botTasks.needsSync")}
          {toggle("allowMerge", sync && settings.allowOutboundComments, "settings.botTasks.needsOutbound")}
        </SettingsRows>
      </SettingsGroup>
    </div>
  );
}

export function BotTasksSettingsPage() {
  const settings = botTasksStatus(useStoreSelector((state) => state.config));
  const dispatch = useStoreDispatch();
  const save = async (patch: BotTasksPatch) => {
    const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: botTasksPatchBody(patch) });
    dispatch({ type: "configStatus", config });
  };
  return <BotTasksSettingsView settings={settings} save={save} />;
}
