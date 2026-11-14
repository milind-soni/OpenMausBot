// Security: the key is write-only; the server reports configured-or-not, never the value.
import { useEffect, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { LearnMore, SETTINGS_INPUT, SettingRow, SettingsField, SettingsFormFoot, SettingsGroup, SettingsRows, StatusDot, Switch } from "./SettingsPrimitives";
import { Select } from "./Select";
import { WorkersAiKeyCard } from "./WorkersAiKeyCard";
import { openKeySettings } from "./keys/key-focus";

const KEY_URL = { jev: "https://typesafe.ai", openrouter: "https://openrouter.ai/keys" } as const;
const KEY_SLOT = {
  jev: { credential: "jevApiKey", field: "key" },
  openrouter: { credential: "openrouterDeciderKey", field: "openrouterKey" },
  custom: { credential: "customDeciderKey", field: "customKey" },
} as const;
const COPY: Record<"jev" | "openrouter" | "custom", { master: LocaleKey; needsKey: LocaleKey; keyLabel: LocaleKey; placeholder: LocaleKey }> = {
  jev: { master: "decider.master", needsKey: "decider.masterNeedsKey", keyLabel: "decider.key.label", placeholder: "decider.key.placeholder" },
  openrouter: {
    master: "decider.openrouter.master", needsKey: "decider.masterNeedsKey.openrouter",
    keyLabel: "decider.openrouter.key.label", placeholder: "decider.openrouter.key.placeholder",
  },
  custom: { master: "decider.custom.master", needsKey: "decider.custom.masterNeedsKey", keyLabel: "decider.custom.key.label", placeholder: "decider.custom.key.placeholder" },
};
/** The room decision budget in server/decider/room-routing.ts; slower falls back to the lead. */
const ROOM_BUDGET_MS = 1_500;

type Provider = "jev" | "openrouter" | "custom";
type ModelList = { source: "openrouter" | "builtin"; models: Array<{ id: string; name: string; group: "recommended" | "more"; api?: "chat" | "decisions" }> };
type TestResult = { ok: true; latencyMs: number } | { ok: false; reason: string; status?: number };

const FAILURES: Record<string, LocaleKey> = {
  rejected: "decider.error.rejected",
  unreachable: "decider.error.unreachable",
  timeout: "decider.error.timeout",
  rate_limited: "decider.error.rateLimited",
  overloaded: "decider.error.overloaded",
  malformed: "decider.error.malformed",
  no_key: "decider.error.noKey",
  misconfigured: "decider.error.misconfigured",
};

/** Cloud Pro's relay refuses an inactive subscription (402) and a used-up month of decisions (429). */
const INCLUDED_FAILURES: Record<string, LocaleKey> = {
  rejected: "decider.included.error.rejected",
  rate_limited: "decider.included.error.limited",
};

const OPENROUTER_FAILURES: Record<string, LocaleKey> = {
  ...FAILURES,
  rejected: "decider.openrouter.error.rejected",
  unreachable: "decider.openrouter.error.unreachable",
  timeout: "decider.openrouter.error.timeout",
  rate_limited: "decider.openrouter.error.rateLimited",
  overloaded: "decider.openrouter.error.overloaded",
  malformed: "decider.openrouter.error.malformed",
};

const CUSTOM_FAILURES: Record<string, LocaleKey> = {
  ...FAILURES,
  rejected: "decider.custom.error.rejected",
  unreachable: "decider.custom.error.unreachable",
  timeout: "decider.custom.error.timeout",
  rate_limited: "decider.custom.error.rateLimited",
  overloaded: "decider.custom.error.overloaded",
  malformed: "decider.custom.error.malformed",
  misconfigured: "decider.custom.error.misconfigured",
};

const WORKERS_AI_FAILURES: Record<string, LocaleKey> = {
  ...FAILURES,
  rejected: "decider.workersAi.error.rejected",
  unreachable: "decider.workersAi.error.unreachable",
  timeout: "decider.workersAi.error.timeout",
  rate_limited: "decider.workersAi.error.rateLimited",
  overloaded: "decider.workersAi.error.overloaded",
  malformed: "decider.workersAi.error.malformed",
};

const BY: Record<"jev" | "workersai" | "openrouter" | "custom", LocaleKey> = {
  jev: "decider.status.byJev", workersai: "decider.status.byWorkersAi", openrouter: "decider.status.byOpenRouter", custom: "decider.status.byCustom",
};

/** Who decides and who reads, in a word each: the person's own key, the Cloud plan's, or nothing yet. */
export function helpersStatusLine(config: ConfigStatus | null): string {
  const decider = config?.decider;
  const extraction = config?.helpers?.extraction;
  const decisions = !decider?.configured ? t("decider.status.notSetUp")
    : decider.included ? t("decider.status.byCloud") : t(BY[decider.provider] ?? BY.jev);
  const reading = !extraction?.provider ? t("decider.status.notSetUp")
    : extraction.included ? t("decider.status.byCloud") : t(BY[extraction.provider]);
  return t("decider.status.line", { decisions, extraction: reading });
}

/** A fixed sentence per failure: the vendor's own body never reaches the UI. */
export function deciderFailureText(result: { reason: string; status?: number }, included = false, provider: Provider | "workersai" = "jev"): string {
  if (provider === "workersai") {
    if (result.reason === "http_error") return t("decider.workersAi.error.http", { status: String(result.status ?? "?") });
    const key = WORKERS_AI_FAILURES[result.reason];
    return key ? t(key) : t("decider.error.other");
  }
  if (provider === "custom") {
    if (result.reason === "http_error") return t("decider.custom.error.http", { status: String(result.status ?? "?") });
    const key = CUSTOM_FAILURES[result.reason];
    return key ? t(key) : t("decider.error.other");
  }
  if (provider === "openrouter") {
    // 402 is OpenRouter's answer for an account with no credits left.
    if (result.reason === "http_error" && result.status === 402) return t("decider.openrouter.error.credits");
    if (result.reason === "http_error") return t("decider.openrouter.error.http", { status: String(result.status ?? "?") });
    const key = OPENROUTER_FAILURES[result.reason];
    return key ? t(key) : t("decider.error.other");
  }
  if (included && result.reason === "http_error" && result.status === 402) return t("decider.included.error.subscription");
  if (included && INCLUDED_FAILURES[result.reason]) return t(INCLUDED_FAILURES[result.reason]!);
  if (result.reason === "http_error") return t("decider.error.http", { status: String(result.status ?? "?") });
  const key = FAILURES[result.reason];
  return key ? t(key) : t("decider.error.other");
}

const asProvider = (value: string | undefined): Provider => (value === "openrouter" || value === "custom" ? value : "jev");

/** A text setting saved when it loses focus or on Enter, and only when it changed. */
function SavedText({ saved, onSave, disabled, label, placeholder, testId }: {
  saved: string; onSave: (value: string) => void; disabled: boolean; label: string; placeholder: string; testId: string;
}) {
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);
  const commit = () => { if (value.trim() !== saved) onSave(value.trim()); };
  return (
    <input
      type="text"
      data-testid={testId}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && commit()}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={label}
      autoComplete="off"
      spellCheck={false}
      className={SETTINGS_INPUT}
    />
  );
}

export function DecisionModelSettings() {
  const { state, dispatch } = useStore();
  const decider = state.config?.decider;
  const provider = asProvider(decider?.provider);
  const openrouter = provider === "openrouter";
  const custom = provider === "custom";
  const configured = decider?.configured ?? false;
  const included = configured && decider?.included === true;
  const usingShared = openrouter && configured && decider?.keySource === "shared";
  const sharedKey = openrouter && decider?.sharedKey === true;
  const ownKey = configured && !included && !usingShared;
  const enabled = decider?.enabled ?? false;
  const roomRouting = decider?.jobs.roomRouting ?? true;
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<ModelList | null>(null);
  const [more, setMore] = useState(false);
  const draft = value.trim();
  const clearing = !draft && ownKey;
  const keyHint: LocaleKey | null = !openrouter || included
    ? null
    : usingShared
      ? "decider.openrouter.status.sharedHint"
      : !configured
        ? "decider.openrouter.status.notConnectedHint"
        : sharedKey
          ? "decider.openrouter.status.ownFallbackHint"
          : null;

  const applied = (config: ConfigStatus) => dispatch({ type: "configStatus", config });

  const patch = async (decision: Record<string, unknown>) => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      applied(await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: decision }) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSwitching(false);
    }
  };

  useEffect(() => {
    if (!openrouter || models) return;
    let cancelled = false;
    api<ModelList>("/api/decider/models").then(
      (list) => { if (!cancelled) setModels(list); },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [openrouter, models]);

  const choose = (decision: { provider: Provider } | { openrouterModel: string; openrouterApi: "chat" | "decisions" } | { customApi: "systemone" | "decisions" }) => {
    setValue("");
    setVerdict(null);
    void patch(decision);
  };

  const save = async () => {
    if (saving || (!draft && !ownKey)) return;
    setSaving(true);
    setError(null);
    setVerdict(null);
    try {
      const status = window.ogb?.setCredential
        ? await window.ogb.setCredential(KEY_SLOT[provider].credential, draft)
        : await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: { [KEY_SLOT[provider].field]: draft } }) });
      applied(status);
      setValue("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (testing || saving || (!draft && !configured)) return;
    setTesting(true);
    setVerdict(null);
    setError(null);
    const testingIncluded = !draft && included;
    const testingShared = !draft && usingShared;
    try {
      const result = await api<TestResult>("/api/decider/test", { method: "POST", body: JSON.stringify(draft ? { key: draft } : {}) });
      setVerdict(result.ok
        ? {
          ok: true,
          text: openrouter || custom
            ? [
              t(custom ? "decider.custom.test.ok" : testingShared ? "decider.openrouter.test.okShared" : "decider.openrouter.test.ok", { ms: String(result.latencyMs) }),
              ...(result.latencyMs > ROOM_BUDGET_MS ? [t("decider.test.slow")] : []),
            ].join(" ")
            : t("decider.test.ok", { ms: String(result.latencyMs) }),
        }
        : { ok: false, text: deciderFailureText(result, testingIncluded, provider) });
    } catch (cause) {
      setVerdict({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setTesting(false);
    }
  };

  const keyLabel = t(COPY[provider].keyLabel);
  const keyStatus = included
    ? t("keys.includedWithCloudPro")
    : usingShared
      ? t("decider.openrouter.status.shared")
      : configured
        ? t(sharedKey ? "decider.openrouter.status.own" : "decider.status.connected")
        : t("decider.status.notConnected");
  return (
    <>
      <SettingsGroup label={t("settings.ai.routing")} block="routing"
        description={<>{t("decider.introShort")}{" "}<LearnMore onClick={() => setMore(!more)} /></>}>
        {more && <p data-decider-more="" className="px-4 text-[12px] leading-4 text-ink-secondary">{t("decider.intro")}</p>}
        <SettingsRows>
          <SettingRow
            title={t(COPY[provider].master)}
            subtitle={<span role="status" data-testid="helpers-status">{helpersStatusLine(state.config)}</span>}
            message={configured ? undefined : t(COPY[provider].needsKey)}
          >
            <Switch
              data-testid="decider-master"
              aria-label={t(COPY[provider].master)}
              checked={enabled}
              disabled={!configured || switching || !state.config}
              onClick={() => void patch({ enabled: !enabled })}
              className="cursor-pointer"
            />
          </SettingRow>
        </SettingsRows>
      </SettingsGroup>
      <WorkersAiKeyCard failureText={(result) => deciderFailureText(result, false, "workersai")} />
      <SettingsGroup label={t("decider.provider.label")} block="routing-key">
        <SettingsRows selectWidth={200}>
          <SettingRow title={t("decider.provider.title")}>
            <Select
              data-testid="decider-provider"
              value={provider}
              onChange={(event) => choose({ provider: asProvider(event.target.value) })}
              disabled={switching || !state.config}
              aria-label={t("decider.provider.label")}
            >
              <option value="jev">{t("decider.provider.jev")}</option>
              <option value="openrouter">{t("decider.provider.openrouter")}</option>
              <option value="custom">{t("decider.provider.custom")}</option>
            </Select>
          </SettingRow>
          {custom && (
            <>
              <SettingRow title={t("decider.custom.baseUrl")} subtitle={t("decider.custom.baseUrlDetail")}>
                <SavedText testId="decider-custom-base-url" saved={decider?.baseUrl ?? ""} disabled={switching}
                  label={t("decider.custom.baseUrl")} placeholder={t("decider.custom.baseUrlPlaceholder")}
                  onSave={(customBaseUrl) => void patch({ customBaseUrl })} />
              </SettingRow>
              <SettingRow title={t("decider.custom.model")}>
                <SavedText testId="decider-custom-model" saved={decider?.model ?? ""} disabled={switching}
                  label={t("decider.custom.model")} placeholder={t("decider.custom.modelPlaceholder")}
                  onSave={(customModel) => void patch({ customModel })} />
              </SettingRow>
              <SettingRow title={t("decider.custom.api")}>
                <Select
                  data-testid="decider-custom-api"
                  value={decider?.api === "decisions" ? "decisions" : "systemone"}
                  onChange={(event) => choose({ customApi: event.target.value === "decisions" ? "decisions" : "systemone" })}
                  disabled={switching}
                  aria-label={t("decider.custom.api")}
                >
                  <option value="systemone">{t("decider.custom.api.systemone")}</option>
                  <option value="decisions">{t("decider.custom.api.decisions")}</option>
                </Select>
              </SettingRow>
            </>
          )}
          {openrouter && (
            <SettingRow title={t("decider.model.label")} subtitle={models?.source === "builtin" ? t("decider.model.builtinNote") : undefined}>
              <Select
                data-testid="decider-model"
                value={decider?.model ?? ""}
                onChange={(event) => choose({
                  openrouterModel: event.target.value,
                  openrouterApi: models?.models.find((model) => model.id === event.target.value)?.api ?? "chat",
                })}
                disabled={switching}
                aria-label={t("decider.model.label")}
              >
                {decider?.model && !models?.models.some((model) => model.id === decider.model) && (
                  <option value={decider.model}>{decider.model}</option>
                )}
                {(["recommended", "more"] as const).map((group) => {
                  const inGroup = models?.models.filter((model) => model.group === group) ?? [];
                  return inGroup.length > 0 && (
                    <optgroup key={group} label={t(group === "recommended" ? "decider.model.recommended" : "decider.model.more")}>
                      {inGroup.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                    </optgroup>
                  );
                })}
              </Select>
            </SettingRow>
          )}
          <div data-decider-key="" className="flex flex-col gap-2 px-4 pb-1 pt-3">
            <SettingsField label={keyLabel}>
              <input
                type="password"
                value={value}
                onChange={(event) => { setVerdict(null); setError(null); setValue(event.target.value); }}
                onKeyDown={(event) => event.key === "Enter" && void save()}
                disabled={saving}
                placeholder={ownKey ? t("keys.replace") : t(usingShared ? "decider.openrouter.key.overridePlaceholder" : COPY[provider].placeholder)}
                aria-label={keyLabel}
                autoComplete="off"
                spellCheck={false}
                className={SETTINGS_INPUT}
              />
            </SettingsField>
            <p className="text-[13px] leading-[18px] text-ink-secondary">
              {keyHint && <>{t(keyHint)}{" "}</>}
              {keyHint && !ownKey && (
                <><button type="button" data-testid="decider-manage-keys" onClick={() => dispatch(openKeySettings("openrouter"))}
                  className="cursor-pointer text-accent-text hover:underline">{t("decider.openrouter.key.manageLink")}</button>{" "}</>
              )}
              {!usingShared && provider !== "custom" && (
                <a href={KEY_URL[provider]} target="_blank" rel="noopener noreferrer" className="cursor-pointer text-accent-text hover:underline focus-visible:underline">
                  {t(openrouter ? "decider.openrouter.key.getKey" : "decider.key.getKey")}
                </a>
              )}
            </p>
          </div>
          <SettingsFormFoot status={<span className="flex flex-col gap-1">
            <span role="status" className="flex items-center"><StatusDot tone={configured ? "success" : null} />{!configured && <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-ink/20" />}{keyStatus}</span>
            {error && <span role="alert" className="text-danger">{error}</span>}
            {verdict && <span role="status" className={verdict.ok ? "text-ink-secondary" : "text-danger"}>{verdict.text}</span>}
          </span>}>
            <button
              type="button"
              data-testid="decider-test"
              onClick={() => void test()}
              disabled={testing || saving || (!draft && !configured)}
              className="ui-button ui-button-md cursor-pointer rounded-full"
            >
              {testing ? t("keys.testing") : t("keys.test")}
            </button>
            <button
              type="button"
              data-testid="decider-save"
              onClick={() => void save()}
              disabled={saving || (!draft && !ownKey)}
              title={clearing ? t("keys.removeKey") : t("common.save")}
              className={cn("ui-button ui-button-md cursor-pointer rounded-full", clearing && "!text-danger")}
            >
              {saving ? t("settings.threads.saving") : clearing ? t("keys.clear") : t("common.save")}
            </button>
          </SettingsFormFoot>
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup label={t("decider.jobs.title")} block="routing-jobs">
        <SettingsRows>
          <SettingRow title={t("decider.jobs.roomRouting")} subtitle={t("decider.jobs.roomRoutingDetail")}>
            <Switch
              data-testid="decider-job-roomRouting"
              aria-label={t("decider.jobs.roomRouting")}
              checked={enabled && roomRouting}
              disabled={!enabled || switching}
              onClick={() => void patch({ jobs: { roomRouting: !roomRouting } })}
              className="cursor-pointer"
            />
          </SettingRow>
          {/* Jobs that aren't built yet are not listed: a row nobody can use is noise (§6.5 Not applicable). */}
        </SettingsRows>
      </SettingsGroup>
    </>
  );
}
