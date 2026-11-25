import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import { api, type InstanceInfo } from "@/state/store";
import { useShowInstances } from "@/state/use-show-instances";
import { EngineCard, EngineSections, RefreshEngines, engineReady } from "./EngineLibrary";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { ApiKeyEngineManage, EngineSetup, EngineUpdateNotice, EngineWarningNotice, isApiKeyEngine } from "./EngineSetup";
import { AntigravitySwitchCli } from "./AntigravitySwitchCli";
import { AppCopyNotice } from "./EngineAppCopy";
import { forgetAppCopySwitches } from "@/state/engine-install";
import { AccountsCard, AddAccount, accountGroupOf, accountsReady, type AccountGroup } from "./EngineAccounts";
import { ClaudeEndpoints, CodexEndpoints } from "./ClaudeEndpoints";
import { ClaudeBedrockEndpoints } from "./ClaudeBedrock";
import { DEVICE_SIGN_IN_COPY, deviceSignInProvider } from "./DeviceSignIn";
import { AntigravityFreeSpace } from "./AntigravityFreeSpace";
import { CacheKeepWarmSettings } from "./CacheKeepWarmSettings";
import { ConfirmDialog } from "./ConfirmDialog";
import { Select } from "./Select";
import { SettingsFoldRow, SettingsGroup, SettingsMark, SettingsRows, StatusDot } from "./SettingsPrimitives";
import { OllamaModels, ollamaShortStatus } from "./OllamaStatusLine";
import { isAddedServer } from "@/lib/openai-compat-endpoints";
import { InstanceProviderMark } from "./ProviderIcons";
import { GEMINI_PRESET, GeminiServer, hasGeminiServer } from "./OpenAiCompatServers";
import { HiddenEngines, HiddenProviderRows, useHiddenProviders } from "./HiddenProviders";
import { AdminOnly } from "./AdminOnly";
import { modelgoOfferable } from "@/lib/modelgo-offer";
import { sameFields, useStoreActions, useStoreSelector } from "@/state/store-select";

export { HiddenEngines };

interface ProbeResult {
  ok: boolean;
  version?: string;
  message?: string;
}

function CustomPicker({ instance, cliDefault, onClose, onSaved }: {
  instance: InstanceInfo;
  cliDefault?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<string[] | null>(instance.cliCandidates ?? null);
  // Starts empty: a select whose value names a missing option shows the placeholder yet still holds that value.
  const [selected, setSelected] = useState<string>("");
  const [manual, setManual] = useState<string>(
    instance.cli && !(instance.cliCandidates ?? []).includes(instance.cli) ? instance.cli : "",
  );
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    api(`/api/cli-candidates?name=${encodeURIComponent(cliDefault ?? "")}`)
      .then(({ candidates: found }: { candidates: string[] }) => {
        setCandidates(found);
        if (!instance.cli) return;
        if (found.includes(instance.cli)) setSelected(instance.cli);
        else setManual(instance.cli);
      })
      .catch(() => setCandidates((prev) => prev ?? []));
  }, [cliDefault, instance.cli]);

  const value = manual.trim() || selected;
  const dirty = value !== (instance.cli ?? "");
  const busy = probing || saving;

  useEffect(() => {
    setProbe(null);
  }, [value]);

  const persist = () => {
    if (busy || !value || !dirty) return;
    setSaving(true);
    setError(null);
    const committed = value;
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ cli: committed }),
    })
      .then(() => Promise.resolve(onSaved()).catch(() => {}))
      .then(onClose)
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const save = () => {
    if (busy || !value || !dirty) return;
    setProbing(true);
    setError(null);
    api("/api/cli-test", {
      method: "POST",
      body: JSON.stringify({ cli: value, driver: instance.driverKind }),
    })
      .then((result: ProbeResult) => {
        setProbe(result);
        if (result.ok) persist();
      })
      .catch((e) => setError(e.message))
      .finally(() => setProbing(false));
  };

  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {candidates !== null && candidates.length > 0 && (
        <Select
          className="w-full font-mono"
          value={manual.trim() ? "" : selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setManual("");
          }}
          aria-label={t("engines.detectedAria", { name: instance.displayName })}
          disabled={busy}
        >
          <option value="">{t("engines.selectBinary")}</option>
          {candidates.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </Select>
      )}
      <input
        type="text"
        value={manual}
        onChange={(e) => setManual(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (!value || !dirty) return;
          save();
        }}
        placeholder={candidates?.length ? t("engines.manualPath") : "/absolute/path/to/cli"}
        aria-label={t("engines.customAria", { name: instance.displayName })}
        spellCheck={false}
        disabled={busy}
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink placeholder:font-sans placeholder:text-ink-secondary focus:outline-none disabled:opacity-50"
      />
      {probe && !probe.ok && probe.message && (
        <div role="alert" className="flex gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2 text-[12px] leading-relaxed text-warning">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>{t("engines.testFailed", { message: probe.message })}</span>
        </div>
      )}
      {probe?.ok && probe.version && (
        <div className="text-[12px] text-success">{t("engines.testPassed", { version: probe.version })}</div>
      )}
      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={busy}
          className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
        >
          {t("common.cancel")}
        </button>
        {probe && !probe.ok ? (
          <>
            <button
              onClick={() => setProbe(null)}
              disabled={busy}
              className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
            >
              {t("engines.editPath")}
            </button>
            <button
              onClick={() => persist()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-danger hover:bg-raised-hover disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : t("engines.saveAnyway")}
            </button>
          </>
        ) : (
          <button
            onClick={save}
            disabled={busy || !value || !dirty}
            className={cn(
              "flex w-[72px] items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px]",
              "bg-raised text-ink hover:bg-raised-hover",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />{t("common.save")}</>}
          </button>
        )}
      </div>
    </div>
  );
}

/** The executable behind an engine: its path, Claude's self-update, and a reset to the default. */
function EngineAdvanced({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStoreActions();
  const showInstances = useShowInstances();
  const [open, setOpen] = useState(false);
  const cliMotion = useMenuMotion(open);
  const [switching, setSwitching] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updatedVersion, setUpdatedVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wasOpenFor = useRef<string | null>(null);

  useEffect(() => {
    if (wasOpenFor.current !== null && wasOpenFor.current !== instance.cli) {
      setOpen(false);
    }
    wasOpenFor.current = instance.cli ?? null;
  }, [instance.cli]);

  const reset = () => {
    if (switching || updating) return;
    setSwitching(true);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ cli: "" }),
    })
      .then(() => Promise.resolve(refreshInstances()).catch(() => {}))
      .catch((e) => setError(e.message))
      .finally(() => setSwitching(false));
  };

  /** Out of every model list until Unhide; the CLI and its sign-in stay as they are. Refused while something uses it. */
  const hide = () => {
    if (switching || updating) return;
    setSwitching(true);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, { method: "PATCH", body: JSON.stringify({ hidden: true }) })
      .then((answer) => showInstances(answer).catch(() => {}))
      .catch((e) => setError(e.message))
      .finally(() => setSwitching(false));
  };

  const updateClaude = () => {
    if (switching || updating) return;
    setUpdating(true);
    setUpdatedVersion(null);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}/claude-update`, {
      method: "POST",
      body: JSON.stringify({}),
    })
      .then(async ({ version }: { version: string }) => {
        setUpdatedVersion(version);
        await Promise.resolve(refreshInstances()).catch(() => {});
      })
      .catch((e) => setError(e.message))
      .finally(() => setUpdating(false));
  };

  return (
      <details className="mt-4 border-t border-hairline/40 pt-3">
        <summary className="cursor-pointer rounded-md py-1 text-[12px] font-medium text-ink-secondary outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">{t("engines.library.advanced")}</summary>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("engines.footer")}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
          {instance.cli ? (
            <span className="w-full break-all font-mono text-[12px] text-ink-secondary" title={instance.cli}>
              {instance.cli}
            </span>
          ) : (
            instance.cliDefault && (
              <span className="break-all font-mono text-[11px] text-ink-secondary">{instance.cliDefault}</span>
            )
          )}
          {instance.snapshot.version && (
            <span className="break-all text-[11px] text-ink-secondary" title={instance.snapshot.version}>
              {instance.snapshot.version}
            </span>
          )}
          <span className="flex-1" />
          {instance.driverKind === "claudeAgent" && (
            <button
              onClick={updateClaude}
              disabled={switching || updating}
              className="flex shrink-0 items-center gap-1 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-50"
            >
              {updating ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {updating ? t("engines.updating") : t("engines.updateClaude")}
            </button>
          )}
          {instance.cli && (
            <button
              onClick={reset}
              disabled={switching || updating}
              className="shrink-0 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-50"
            >
              {switching ? t("engines.resetting") : t("engines.reset")}
            </button>
          )}
          <button
            type="button"
            data-hide-engine={instance.instanceId}
            onClick={hide}
            disabled={switching || updating}
            title={t("engines.hideHint")}
            className="shrink-0 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-50"
          >
            {t("engines.hide")}
          </button>
          <button
            onClick={() => setOpen((v) => !v)}
            disabled={updating}
            aria-expanded={open}
            className={cn(
              "shrink-0 rounded-lg border border-hairline/40 px-3 py-1 text-[12px]",
              open ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
              "disabled:opacity-50",
            )}
          >
            {t("engines.setCli")}
          </button>
        </div>
        {updatedVersion && (
          <div role="status" className="mt-1 text-[12px] text-success">{t("engines.claudeUpdated", { version: updatedVersion })}</div>
        )}
        {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
        {cliMotion.shown && (
          <div className={cliMotion.className} {...cliMotion.exitProps}>
            <CustomPicker
              instance={instance}
              cliDefault={instance.cliDefault}
              onClose={() => setOpen(false)}
              onSaved={refreshInstances}
            />
          </div>
        )}
      </details>
  );
}

/** Remove drops an added Antigravity account or an added server; Sign out forgets a signed-in account's sign-in (Antigravity's
 * Google one, or a CLI's own login such as Kimi's) and never hides the provider, which stays listed with Set up. */
function EngineAccountAction({ instance, action, cli = false, removeBody = "accounts.removeBodyAntigravity" }: { instance: InstanceInfo; action: "remove" | "signOut"; cli?: boolean; removeBody?: LocaleKey }) {
  const showInstances = useShowInstances();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = action === "remove";
  const usedBy = useStoreSelector((s) => remove ? s.bots.filter((bot) => bot.modelSelection.instanceId === instance.instanceId).length : 0);
  const label = t(remove ? "accounts.remove" : "accounts.signOut");
  const run = async () => {
    setConfirming(false);
    setRunning(true);
    setError(null);
    try {
      const path = `/api/instances/${encodeURIComponent(instance.instanceId)}${remove ? "" : "/auth/sign-out"}`;
      await showInstances(await api(path, { method: remove ? "DELETE" : "POST" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };
  return <>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={running || usedBy > 0} onClick={() => setConfirming(true)} aria-label={remove ? undefined : t("accounts.signOutAria", { name: instance.displayName })} className={cn("rounded-lg px-2.5 py-1.5 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-50", remove ? "text-danger hover:bg-danger/10" : "text-ink-secondary hover:bg-raised hover:text-ink")}>
        {running ? <Loader2 size={13} className="animate-spin" /> : label}
      </button>
      {usedBy > 0 && <p className="text-[11px] text-ink-secondary">{t("accounts.inUse", { count: String(usedBy) })}</p>}
    </div>
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    <ConfirmDialog open={confirming} title={t(remove ? "accounts.removeTitle" : "accounts.signOutTitle", { name: instance.displayName })}
      body={remove ? t(removeBody) : cli
        // The CLI's own sign-in is the one removed: its files in the home folder of the computer this app runs on.
        ? <>{t("accounts.signOutBody")}<span data-sign-out-cli="" className="mt-2 block">{t("accounts.signOutCliBody", { name: instance.displayName })}</span></>
        : t("accounts.signOutBody")}
      confirmLabel={label} tone="neutral" pending={running} onCancel={() => { if (!running) setConfirming(false); }} onConfirm={() => void run()} />
  </>;
}

function AntigravityAddAccount({ source }: { source: InstanceInfo }) {
  const state = useStoreSelector((s) => ({ instances: s.instances }), sameFields);
  const [addedId, setAddedId] = useState<string | null>(null);
  const added = addedId ? state.instances.find((instance) => instance.instanceId === addedId && instance.snapshot.authenticated !== true) : undefined;
  return <>
    <AddAccount label={t("engineSetup.antigravity.addAccount")} endpoint="/api/instances/antigravity-accounts" extra={{ sourceInstanceId: source.instanceId }} onAdded={setAddedId} />
    {added && <div data-antigravity-added={added.instanceId}><EngineSetup instance={added} unframed /></div>}
  </>;
}

function EngineRow({ instance, bare = false }: { instance: InstanceInfo; bare?: boolean }) {
  const policyNote = instance.policy && <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">
    <span className="font-medium text-ink">{t("policy.managedBy", { organization: instance.policy.organizationName })}</span> · {instance.policy.reason}
  </p>;
  if (instance.trialCredit) return <EngineCard instance={instance} bare={bare}>
    <p data-trial-credit={instance.trialCredit} className="text-[13px] leading-relaxed text-ink-secondary">{t(instance.trialCredit === "used_up" ? "engines.trialCreditUsedUp"
      : instance.trialCredit === "ended" ? "engines.trialCreditEnded" : engineReady(instance) ? "engines.trialCredit" : "engines.trialCreditOwn")}</p>
  </EngineCard>;
  if (instance.readOnly) return <EngineCard instance={instance} bare={bare}>
    {policyNote}
    <p className="text-[13px] leading-relaxed text-ink-secondary">{t("organization.managedEngine")}</p>
    {!engineReady(instance) && <p className="mt-2 text-[12px] text-ink-secondary">{t("organization.engineUnavailable")}</p>}
  </EngineCard>;

  return (
    <EngineCard instance={instance} bare={bare}>
      {policyNote}
      {!engineReady(instance) && <EngineSetup instance={instance} intent={instance.access === "custom" ? "inject" : "cloud"} description={instance.codexEndpoint ? t("agentEndpoints.codexHint") : undefined} unframed />}
      {engineReady(instance) && <ApiKeyEngineManage instance={instance} className="mt-3" />}
      {engineReady(instance) && instance.serverKind === "ollama" && <OllamaModels instance={instance} className="mt-3" />}
      {/* A server added by address (LM Studio, Ollama, a gateway) is removed here too, not only from API keys. */}
      {isAddedServer(instance) && <div className="mt-3"><EngineAccountAction instance={instance} action="remove" removeBody="claudeEndpoints.removeBody" /></div>}
      {/* The setup panel that first said so is gone once the engine is Ready. */}
      {engineReady(instance) && <AppCopyNotice instance={instance} className="mt-3" />}
      {instance.snapshot.update && <EngineUpdateNotice update={instance.snapshot.update} instance={instance} className="mt-3" quiet />}
      <AntigravitySwitchCli instance={instance} />
      {instance.snapshot.warning && <EngineWarningNotice warning={instance.snapshot.warning} className="mt-3" />}
      {engineReady(instance) && instance.snapshot.authenticated === true && (
        instance.authentication?.method === "device-code"
          ? <p className="flex items-center gap-1.5 text-[12px] text-success"><Check size={13} />{t(DEVICE_SIGN_IN_COPY[deviceSignInProvider(instance.driverKind)].connectedAccount)}</p>
          : instance.authentication?.method === "paste-code" && (
            <p className="flex items-center gap-1.5 text-[12px] text-success"><Check size={13} />{t("engineSetup.claude.connectedAccount")}</p>
          )
      )}
      {/* Not for an engine a provider key signs in: removing its own sign-in would leave it connected. */}
      {instance.driverKind !== "antigravityAgent" && engineReady(instance) && instance.snapshot.authenticated === true && instance.authentication?.signOut === true && instance.snapshot.account?.method !== "api-key" && (
        <div data-engine-sign-out={instance.instanceId} className="mt-3"><EngineAccountAction instance={instance} action="signOut" cli /></div>
      )}
      {instance.freeUpSpace && <AntigravityFreeSpace instance={instance} />}
      {instance.driverKind === "antigravityAgent" && (
        <div className="mt-3 space-y-3">
          {instance.snapshot.authenticated && <p className="break-words text-[12px] text-ink-secondary">{instance.snapshot.account?.email ?? t("engineSetup.antigravity.signedInGoogle")}</p>}
          <AntigravityAddAccount source={instance} />
          {instance.snapshot.authenticated === true && instance.authentication?.signOut === true && <EngineAccountAction instance={instance} action="signOut" />}
          {instance.instanceId.startsWith("antigravity-") && <EngineAccountAction instance={instance} action="remove" />}
        </div>
      )}
      <EngineAdvanced instance={instance} />
    </EngineCard>
  );
}

/** "Ready", "Not set up", "Needs attention": the status first, with its 6 px dot. */
function simpleStatus(instance: InstanceInfo, ready: boolean): { tone: "success" | "warning" | null; text: string } {
  if (ready) {
    const email = instance.snapshot.authenticated === true ? instance.snapshot.account?.email : undefined;
    return { tone: "success", text: email ? `${t("settings.ai.ready")} · ${email}` : t("settings.ai.ready") };
  }
  if (instance.snapshot.ollama) return { tone: null, text: ollamaShortStatus(instance.snapshot.ollama) };
  if (instance.snapshot.state === "available" && instance.snapshot.authenticated === false) return { tone: "warning", text: t("settings.ai.attention") };
  // What it still needs, in a few plain words: an account sign-in or a key.
  const needs = instance.authentication !== undefined ? t("settings.ai.needsAccountOrKey") : t("settings.ai.needsKey");
  return { tone: null, text: `${t("settings.ai.notSetUp")} · ${needs}` };
}

/** One provider: its mark in the 32 px slot, the status under the name, and one Set up / Manage that opens its fold
 * inside the same card. */
function ProviderRow({ instance, ready, open, onToggle, compact, children }: {
  instance: InstanceInfo; ready: boolean; open: boolean; onToggle: () => void; compact: boolean; children: ReactNode;
}) {
  const status = simpleStatus(instance, ready);
  return <>
    <div data-simple-engine={instance.instanceId} className={cn("flex items-center gap-3 px-4", compact && !ready && !status.tone ? "min-h-11 py-1.5" : "min-h-16 py-3")}>
      <SettingsMark><InstanceProviderMark instance={instance} size={18} subtle /></SettingsMark>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] leading-5 text-ink">{instance.displayName}</span>
        {!(compact && !ready && !status.tone) && <span className="truncate text-[13px] leading-[18px] text-ink-secondary"><StatusDot tone={status.tone} />{status.text}</span>}
      </span>
      <button type="button" aria-expanded={open} className="ui-button ml-3 shrink-0" onClick={onToggle}>
        {t(open ? "common.close" : ready ? "settings.simple.ai.manage" : "settings.simple.ai.setUp")}
      </button>
    </div>
    {open && <div data-provider-fold={instance.instanceId} className="pb-4 pl-[60px] pr-4 pt-3">{children}</div>}
  </>;
}

const GOOGLE_MARK = { driverKind: "openai-compat", icon: { kind: "preset", preset: "google" } } as const;
/** Google AI Studio has no engine of its own: its Gemini API key adds an OpenAI-compatible server at Google's address,
 * whose own row takes this one's place once it is added. */
function GeminiProviderRow({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <>
    <div data-simple-engine="google-ai-studio" className="flex min-h-16 items-center gap-3 px-4 py-3">
      <SettingsMark><InstanceProviderMark instance={GOOGLE_MARK} size={18} subtle /></SettingsMark>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] leading-5 text-ink">{t("geminiServer.title")}</span>
        <span className="truncate text-[13px] leading-[18px] text-ink-secondary"><StatusDot tone={null} />{`${t("settings.ai.notSetUp")} · ${t("settings.ai.needsKey")}`}</span>
      </span>
      <button type="button" aria-expanded={open} className="ui-button ml-3 shrink-0" onClick={onToggle}>
        {t(open ? "common.close" : "settings.simple.ai.setUp")}
      </button>
    </div>
    {open && <div data-provider-fold="google-ai-studio" className="pb-4 pl-[60px] pr-4 pt-3"><GeminiServer /></div>}
  </>;
}

function SimpleEngines({ rows, isReady, renderEngine, more, accountsOnly = false, offerGemini = false, offerModelgo = false }: {
  rows: InstanceInfo[];
  isReady: (instance: InstanceInfo) => boolean;
  renderEngine: (instance: InstanceInfo, bare?: boolean) => ReactNode;
  more: { id: string; open: boolean; onToggle: () => void };
  /** The chat's sign-in card: every account row in view, no fold and no hidden providers. */
  accountsOnly?: boolean;
  /** Offer the Google AI Studio row: no Gemini server is added yet and this workspace can add one. */
  offerGemini?: boolean;
  /** The sponsor's provider sits in the main list, after the Google AI Studio row, where it may be offered (modelgoOfferable). */
  offerModelgo?: boolean;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  // A hidden provider is gone from the instance list, so without these rows nothing in Settings brings it back.
  const allHidden = useHiddenProviders(), hidden = accountsOnly ? [] : allHidden;
  const featured = rows.filter((instance) => accountsOnly || isReady(instance) || instance.authentication !== undefined || hasGeminiServer([instance]));
  const modelgo = offerModelgo && !accountsOnly && !featured.some((instance) => instance.driverKind === "modelgo")
    ? rows.find((instance) => instance.driverKind === "modelgo") : undefined;
  const others = rows.filter((instance) => !featured.includes(instance) && instance !== modelgo);
  // A hidden Gemini server comes back through its own hidden row; adding another would only make a second one.
  const gemini = offerGemini && !hidden.some((provider) => provider.driverKind === "openai-compat" && provider.displayName === GEMINI_PRESET.name);
  const folded = others.length + hidden.length;
  const row = (instance: InstanceInfo, compact: boolean) => {
    const open = opened === instance.instanceId;
    return <ProviderRow key={instance.instanceId} instance={instance} ready={isReady(instance)} open={open} compact={compact}
      onToggle={() => setOpened(open ? null : instance.instanceId)}>{renderEngine(instance, true)}</ProviderRow>;
  };
  return (
    <SettingsGroup label={t("settings.ai.providers")} actions={<RefreshEngines />}>
      <SettingsRows icons>
        {featured.map((instance) => row(instance, false))}
        {gemini && <GeminiProviderRow open={opened === "google-ai-studio"} onToggle={() => setOpened(opened === "google-ai-studio" ? null : "google-ai-studio")} />}
        {modelgo && row(modelgo, false)}
        {folded > 0 && (
          <SettingsFoldRow id={more.id} title={t("settings.ai.moreProviders")} value={String(folded)} open={more.open} onToggle={more.onToggle}
            leading={<span aria-hidden="true" />}>
            {others.map((instance) => row(instance, true))}
            <HiddenProviderRows hidden={hidden} />
          </SettingsFoldRow>
        )}
      </SettingsRows>
    </SettingsGroup>
  );
}

/** A provider's accounts share one card, which takes the place of its first account. */
function groupedAccounts(listed: InstanceInfo[]) {
  const groups = new Map<AccountGroup, InstanceInfo[]>();
  for (const instance of listed) {
    const group = accountGroupOf(instance);
    if (group) groups.set(group, [...groups.get(group) ?? [], instance]);
  }
  const groupOf = (instance: InstanceInfo) => {
    const group = accountGroupOf(instance);
    return group && groups.get(group)?.[0] === instance ? group : null;
  };
  return { groups, groupOf, rows: listed.filter((instance) => !accountGroupOf(instance) || groupOf(instance)) };
}

/** The chat's AI sign-in card: Simple Providers with only the accounts a person signs in to (Claude, ChatGPT or Codex,
 * Antigravity), for an owner or admin. */
export function AiSignInSettings() {
  const state = useStoreSelector((s) => ({ instances: s.instances }), sameFields);
  const { groups, groupOf, rows } = groupedAccounts(state.instances.filter((instance) => accountGroupOf(instance) !== null || (instance.driverKind === "antigravityAgent" && !instance.readOnly)));
  const isReady = (instance: InstanceInfo) => { const group = groupOf(instance); return group ? accountsReady(groups.get(group)!) : engineReady(instance); };
  const renderEngine = (instance: InstanceInfo, bare = false) => {
    const group = groupOf(instance);
    return group ? <AccountsCard group={group} accounts={groups.get(group)!} bare={bare} /> : <EngineRow instance={instance} bare={bare} />;
  };
  return <AdminOnly><div data-ai-sign-in="">
    <SimpleEngines rows={rows} isReady={isReady} renderEngine={renderEngine} accountsOnly more={{ id: "ai-sign-in-more", open: false, onToggle: () => {} }} />
  </div></AdminOnly>;
}

export function EnginesSettings({ simple = false, more }: { simple?: boolean; more?: { id: string; open: boolean; onToggle: () => void } }) {
  const state = useStoreSelector((s) => ({ instances: s.instances, policy: s.config?.managedPolicy }), sameFields);
  // Leaving Settings ends the "now uses the copy OpenMausBot installed" lines.
  useEffect(() => forgetAppCopySwitches, []);
  const listed = state.instances.filter((i) => i.readOnly || i.cli !== undefined || i.cliDefault !== undefined || i.snapshot.state === "unavailable" || isApiKeyEngine(i) || i.claudeEndpoint !== undefined || i.claudeBedrock !== undefined || i.codexEndpoint !== undefined);
  const { groups, groupOf, rows } = groupedAccounts(listed);
  // A hidden ordinary Claude instance takes its card, and the endpoint section inside it, away. A hosted
  // workspace lists every engine read-only and refuses instance changes, so there the section has no Add.
  const hostedWorkspace = rows.length > 0 && rows.every((instance) => instance.readOnly);
  const orphanCodexEndpoints = !groups.has("chatgpt") && !hostedWorkspace;
  const orphanEndpoints = !groups.has("claude") && !hostedWorkspace;
  const isReady = (instance: InstanceInfo) => { const group = groupOf(instance); return group ? accountsReady(groups.get(group)!) : engineReady(instance); };
  const renderEngine = (instance: InstanceInfo, bare = false) => {
    const group = groupOf(instance);
    return group
      ? <AccountsCard group={group} accounts={groups.get(group)!} bare={bare}
        advanced={<>{group === "claude" ? <><ClaudeEndpoints /><ClaudeBedrockEndpoints /></> : <CodexEndpoints />}<EngineAdvanced instance={instance} /></>} />
      : <EngineRow instance={instance} bare={bare} />;
  };

  if (simple && more) return <>
    <SimpleEngines rows={rows} isReady={isReady} renderEngine={renderEngine} more={more} offerGemini={!hostedWorkspace && !hasGeminiServer(state.instances)}
      offerModelgo={modelgoOfferable(state.policy)} />
    {orphanEndpoints && <div className="px-4"><ClaudeEndpoints /><ClaudeBedrockEndpoints /></div>}
    {orphanCodexEndpoints && <div className="px-4"><CodexEndpoints /></div>}
  </>;

  return (
    <div className="flex min-w-0 flex-col gap-6 pb-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-60 space-y-2 px-4">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{t("settings.engines.title")}</h1>
          <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-ink-secondary">{t("engines.library.intro")}</p>
        </div>
        <RefreshEngines />
      </div>
      <EngineSections instances={rows} isReady={isReady} renderEngine={renderEngine} />
      {orphanEndpoints && <div className="px-4"><ClaudeEndpoints /><ClaudeBedrockEndpoints /></div>}
      {orphanCodexEndpoints && <div className="px-4"><CodexEndpoints /></div>}
      <HiddenEngines />
      <CacheKeepWarmSettings />
    </div>
  );
}
