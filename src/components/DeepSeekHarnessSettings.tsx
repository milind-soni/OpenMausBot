import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { EFFORT_LEVELS, type EffortLevel } from "../../server/contracts";
import {
  DEEPSEEK_HARNESS_MAX_TOKEN_LIMIT,
  type DeepSeekHarnessPublicErrorCode,
} from "../../shared/deepseek-harness";
import { cn } from "@/lib/cn";
import { effortLevelsForModel } from "@/lib/model-effort";
import {
  deepSeekHarnessActions,
  DeepSeekHarnessApiError,
  type DeepSeekHarnessActions,
  type DeepSeekHarnessConnectionPatch,
  type DeepSeekHarnessModelProfile,
  type DeepSeekHarnessReasoningEffort,
  type DeepSeekHarnessSettingsSnapshot,
  type DeepSeekHarnessTransport,
  type DeepSeekHarnessUpsertRequest,
  type InstanceInfo,
  useStore,
} from "@/state/store";
import { DeepSeekHarnessMark } from "./ProviderIcons";

type PendingAction = "load" | "save" | "pair" | "discover" | "upsert" | null;

export function createDeepSeekHarnessSubmissionGate() {
  let claimed = false;
  return {
    claim: () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    release: () => {
      claimed = false;
    },
    isBusy: () => claimed,
  };
}

/** Initial reads deliberately bypass the write gate. React Strict Mode mounts,
 * cleans up, and mounts effects again; gating those reads lets the discarded
 * request block the surviving effect and leaves the UI permanently loading. */
export async function runDeepSeekHarnessInitialLoad(
  load: (showPending: boolean) => Promise<"success" | "failure" | "stale">,
  isCurrent: () => boolean,
  settle: () => void,
): Promise<void> {
  await load(false);
  if (isCurrent()) settle();
}

export interface DeepSeekHarnessSettingsViewProps {
  instance: InstanceInfo;
  settings: DeepSeekHarnessSettingsSnapshot | null;
  transport: DeepSeekHarnessTransport;
  baseUrl: string;
  agentPreset: string;
  pairingLink: string;
  provider: string;
  search: string;
  candidates: DeepSeekHarnessModelProfile[];
  modelId: string;
  modelName: string;
  contextWindow: string;
  maxTokens: string;
  reasoningLevels: EffortLevel[];
  loading: boolean;
  pending: PendingAction;
  notice: string | null;
  error: string | null;
  actionErrorCode: DeepSeekHarnessPublicErrorCode | null;
  onTransportChange: (transport: DeepSeekHarnessTransport) => void;
  onBaseUrlChange: (value: string) => void;
  onAgentPresetChange: (value: string) => void;
  onPairingLinkChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onSearchChange: (value: string) => void;
  onModelIdChange: (value: string) => void;
  onModelNameChange: (value: string) => void;
  onContextWindowChange: (value: string) => void;
  onMaxTokensChange: (value: string) => void;
  onReasoningLevelToggle: (level: EffortLevel) => void;
  onSaveConnection: () => void;
  onPair: () => void;
  onDiscover: () => void;
  onChooseCandidate: (candidate: DeepSeekHarnessModelProfile) => void;
  onUpsert: () => void;
  onReload: () => void;
}

const labelForEffort = (level: EffortLevel) => {
  if (level === "none") return "None";
  if (level === "xhigh") return "X-High";
  return `${level[0]!.toUpperCase()}${level.slice(1)}`;
};

function isTrustedLoopback(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function filterDeepSeekHarnessModels(
  models: readonly DeepSeekHarnessModelProfile[],
  search: string,
): DeepSeekHarnessModelProfile[] {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return models.slice(0, 50);
  return models
    .filter((model) => `${model.id}\n${model.name ?? ""}`.toLocaleLowerCase().includes(query))
    .slice(0, 50);
}

export function toDshReasoningEfforts(
  levels: readonly EffortLevel[],
): DeepSeekHarnessReasoningEffort[] | undefined {
  if (levels.length === 0) return undefined;
  return levels.map((level) => level === "none" ? "off" : level);
}

export function fromDshReasoningEfforts(
  levels: readonly DeepSeekHarnessReasoningEffort[],
): EffortLevel[] {
  return levels.map((level) => level === "off" ? "none" : level);
}

const MODEL_TOKENS_HELP = "Whole tokens from 1 to 10,000,000. Leave blank to use the provider default.";

interface DeepSeekHarnessModelDraft {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoningLevels: EffortLevel[];
}

type DeepSeekHarnessModelBuild =
  | { ok: true; model: DeepSeekHarnessModelProfile }
  | {
      ok: false;
      errors: {
        contextWindow?: string;
        maxTokens?: string;
      };
    };

function optionalTokenCount(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return Number.NaN;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= DEEPSEEK_HARNESS_MAX_TOKEN_LIMIT
    ? parsed
    : Number.NaN;
}

export function buildDeepSeekHarnessModelProfile(
  draft: DeepSeekHarnessModelDraft,
): DeepSeekHarnessModelBuild {
  const contextWindow = optionalTokenCount(draft.contextWindow);
  const maxTokens = optionalTokenCount(draft.maxTokens);
  const errors: Extract<DeepSeekHarnessModelBuild, { ok: false }>["errors"] = {};
  if (Number.isNaN(contextWindow)) {
    errors.contextWindow = "Context window must be a whole number from 1 to 10,000,000.";
  }
  if (Number.isNaN(maxTokens)) {
    errors.maxTokens = "Maximum output must be a whole number from 1 to 10,000,000.";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const model: DeepSeekHarnessModelProfile = { id: draft.id.trim() };
  if (draft.name.trim()) model.name = draft.name.trim();
  if (contextWindow !== null) model.contextWindow = contextWindow;
  if (maxTokens !== null) model.maxTokens = maxTokens;
  const reasoningEfforts = toDshReasoningEfforts(draft.reasoningLevels);
  if (reasoningEfforts) model.reasoningEfforts = reasoningEfforts;
  return { ok: true, model };
}

export function modelDraftFromCandidate(candidate: DeepSeekHarnessModelProfile): DeepSeekHarnessModelDraft {
  return {
    id: candidate.id,
    name: candidate.name ?? "",
    contextWindow: candidate.contextWindow === undefined ? "" : String(candidate.contextWindow),
    maxTokens: candidate.maxTokens === undefined ? "" : String(candidate.maxTokens),
    reasoningLevels: fromDshReasoningEfforts(candidate.reasoningEfforts ?? []),
  };
}

export function deepSeekHarnessModelScope(
  settings: DeepSeekHarnessSettingsSnapshot,
  provider: string,
  pairingIdentity: number,
): string {
  return JSON.stringify([
    settings.connection.baseUrl,
    settings.connection.transport,
    settings.connection.hasDeviceCredential,
    provider,
    pairingIdentity,
  ]);
}

interface ModelRequestToken {
  generation: number;
  scope: string;
}

export function createDeepSeekHarnessModelRequestGuard() {
  let generation = 0;
  const accept = (token: ModelRequestToken, currentScope: string) =>
    token.generation === generation && token.scope === currentScope;
  return {
    issue: (scope: string): ModelRequestToken => ({ generation, scope }),
    invalidate: () => {
      generation += 1;
    },
    accept,
    commit: (token: ModelRequestToken, currentScope: string, apply: () => void) => {
      if (!accept(token, currentScope)) return false;
      apply();
      return true;
    },
  };
}

export async function upsertDeepSeekHarnessModelAndRefresh(
  actions: DeepSeekHarnessActions,
  refreshInstances: () => Promise<void>,
  instanceId: string,
  input: DeepSeekHarnessUpsertRequest,
) {
  const result = await actions.upsert(instanceId, input);
  await refreshInstances();
  return result;
}

export function deepSeekHarnessRecovery(code: DeepSeekHarnessPublicErrorCode) {
  const impact = deepSeekHarnessErrorImpact(code);
  return { invalidateModels: impact.invalidateModels, refreshSettings: impact.refreshSettings };
}

export function deepSeekHarnessErrorImpact(code: DeepSeekHarnessPublicErrorCode) {
  const refreshSettings = code === "provider-not-eligible"
    || code === "model-update-conflict"
    || code === "paired-device-unauthorized"
    || code === "paired-plugin-update-required";
  const blocksModelEditor = refreshSettings || code === "pairing-required";
  const invalidateModels = blocksModelEditor;
  return { blocksModelEditor, refreshSettings, invalidateModels };
}

export function deepSeekHarnessErrorMessage(code: DeepSeekHarnessPublicErrorCode): string {
  switch (code) {
    case "settings-busy":
      return "Another provider update is still finishing. Wait a moment and try again.";
    case "model-update-conflict":
      return "DSH settings changed elsewhere. The catalog was refreshed; review it and try again.";
    case "provider-not-eligible":
      return "This provider is not eligible for model management. Refresh providers or choose another one.";
    case "pairing-required":
      return "No approved paired device is stored. Paste a pairing link generated by DSH to connect this device.";
    case "pairing-unavailable":
      return "OpenMausBot could not reach the DSH pairing endpoint. Check the base URL and network or Tailscale access, then retry.";
    case "pairing-rejected":
      return "DSH rejected this pairing link or token because it is invalid or expired. Generate a fresh pairing link and try again.";
    case "invalid-base-url":
      return "Enter an absolute HTTP or HTTPS origin, including its port when needed.";
    case "host-unavailable":
      return "DeepSeek Harness is unreachable from this OpenMausBot host. Check the origin and network access.";
    case "paired-device-unauthorized":
      return "Device access was revoked. Generate a fresh pairing link and pair again.";
    case "paired-plugin-update-required":
      return "Update @linxin666/dsh-remote-web-ui, then check again. Chat and configured models still work.";
    case "model-update-rejected":
      return "DSH rejected this model update. Review the model details and try again.";
    case "invalid-request":
    case "invalid-response":
    case "request-failed":
      return "DeepSeek Harness request failed. Check the connection and try again.";
  }
}

interface DeepSeekHarnessActionFeedback {
  code: DeepSeekHarnessPublicErrorCode | null;
  error: string | null;
}

interface DeepSeekHarnessActionToken {
  generation: number;
}

export function createDeepSeekHarnessActionFeedbackMachine() {
  let generation = 0;
  let feedback: DeepSeekHarnessActionFeedback = { code: null, error: null };
  const isCurrent = (token: DeepSeekHarnessActionToken) => token.generation === generation;
  return {
    begin: (): DeepSeekHarnessActionToken => {
      generation += 1;
      feedback = { code: null, error: null };
      return { generation };
    },
    succeed: (token: DeepSeekHarnessActionToken) => {
      if (!isCurrent(token)) return false;
      feedback = { code: null, error: null };
      return true;
    },
    fail: (token: DeepSeekHarnessActionToken, code: DeepSeekHarnessPublicErrorCode) => {
      if (!isCurrent(token)) return false;
      feedback = { code, error: deepSeekHarnessErrorMessage(code) };
      return true;
    },
    isCurrent,
    snapshot: (): DeepSeekHarnessActionFeedback => ({ ...feedback }),
  };
}

function safeRuntimeReason(instance: InstanceInfo): string {
  const reason = instance.snapshot.reason?.trim();
  return reason && reason.length <= 200 && reason.startsWith("DeepSeek Harness")
    ? reason
    : "DeepSeek Harness cannot run agent turns right now.";
}

function statusCopy(
  instance: InstanceInfo,
  settings: DeepSeekHarnessSettingsSnapshot | null,
  actionErrorCode: DeepSeekHarnessPublicErrorCode | null,
) {
  if (instance.snapshot.state === "unavailable") {
    return { tone: "danger" as const, title: "Provider runtime unavailable", detail: safeRuntimeReason(instance) };
  }
  if (actionErrorCode === "paired-device-unauthorized") {
    return { tone: "danger" as const, title: "Device access was revoked", detail: "Paste a fresh pairing link to restore paired access." };
  }
  if (actionErrorCode === "paired-plugin-update-required") {
    return { tone: "warning" as const, title: "Update the paired web UI plugin", detail: "Update @linxin666/dsh-remote-web-ui, then check again." };
  }
  if (actionErrorCode === "provider-not-eligible") {
    return { tone: "warning" as const, title: "Provider is no longer eligible", detail: "Refresh providers and choose a configured pi-ai provider." };
  }
  if (actionErrorCode === "model-update-conflict") {
    return { tone: "warning" as const, title: "Model catalog changed", detail: "Review the refreshed catalog before saving again." };
  }
  if (actionErrorCode && deepSeekHarnessErrorImpact(actionErrorCode).blocksModelEditor) {
    return { tone: "danger" as const, title: "Connection needs attention", detail: deepSeekHarnessErrorMessage(actionErrorCode) };
  }
  if (!settings && actionErrorCode) {
    return {
      tone: "danger" as const,
      title: actionErrorCode === "host-unavailable" ? "DeepSeek Harness is offline" : "Connection needs attention",
      detail: deepSeekHarnessErrorMessage(actionErrorCode),
    };
  }
  if (!settings) return { tone: "muted" as const, title: "Checking connection…", detail: "Reading DeepSeek Harness settings." };
  const { modelManagement } = settings;
  if (modelManagement.available) {
    if (modelManagement.providers.length === 0) {
      return {
        tone: "warning" as const,
        title: "No configurable pi-ai provider",
        detail: "Configure and activate a pi-ai provider in DSH, then check again.",
      };
    }
    return {
      tone: "success" as const,
      title: settings.connection.transport === "paired" ? "Paired device connected" : "Host API connected",
      detail: `${modelManagement.providers.length} configurable provider${modelManagement.providers.length === 1 ? "" : "s"} available.`,
    };
  }
  if (modelManagement.reasonCode === "paired-device-unauthorized") {
    return {
      tone: "danger" as const,
      title: "Device access was revoked",
      detail: "Paste a fresh pairing link to restore paired access.",
    };
  }
  if (modelManagement.reasonCode === "paired-plugin-update-required") {
    return {
      tone: "warning" as const,
      title: "Update the paired web UI plugin",
      detail: "Chat and configured models still work. Update @linxin666/dsh-remote-web-ui to add or refresh models here.",
    };
  }
  return {
    tone: "danger" as const,
    title: "DeepSeek Harness is offline",
    detail: "Check the configured origin and make sure DSH is reachable from this OpenMausBot host.",
  };
}

function ConnectionStatus({
  instance,
  settings,
  actionErrorCode,
}: {
  instance: InstanceInfo;
  settings: DeepSeekHarnessSettingsSnapshot | null;
  actionErrorCode: DeepSeekHarnessPublicErrorCode | null;
}) {
  const status = statusCopy(instance, settings, actionErrorCode);
  return (
    <div className={cn(
      "flex gap-2.5 rounded-lg border px-3 py-2.5",
      status.tone === "success" && "border-success/20 bg-success/8",
      status.tone === "warning" && "border-warning/25 bg-warning/8",
      status.tone === "danger" && "border-danger/20 bg-danger/8",
      status.tone === "muted" && "border-hairline/40 bg-inset",
    )} role={status.tone === "danger" || status.tone === "warning" ? "alert" : "status"}>
      {status.tone === "success" ? (
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-success" />
      ) : status.tone === "muted" ? (
        <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin text-ink-secondary" />
      ) : (
        <TriangleAlert size={15} className={cn("mt-0.5 shrink-0", status.tone === "warning" ? "text-warning" : "text-danger")} />
      )}
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-ink">{status.title}</div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">{status.detail}</div>
      </div>
    </div>
  );
}

function ConfiguredModels({ instance }: { instance: InstanceInfo }) {
  const visible = instance.models.options.slice(0, 8);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11.5px] font-medium text-ink">Configured models</span>
        <span className="text-[10.5px] tabular-nums text-ink-secondary">{instance.models.options.length}</span>
      </div>
      <div className="divide-y divide-hairline/30 overflow-hidden rounded-lg border border-hairline/35 bg-inset">
        {visible.map((model) => {
          const levels = effortLevelsForModel(
            instance.models.options,
            model.id,
            instance.capabilities?.effortLevels,
          );
          return (
            <div key={model.id} className="flex items-center gap-2 px-2.5 py-2">
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink" title={model.label}>{model.label}</span>
              {!!levels?.length && (
                <span className="shrink-0 text-[9.5px] text-ink-secondary">
                  {levels.map(labelForEffort).join(" · ")}
                </span>
              )}
            </div>
          );
        })}
        {visible.length === 0 && <div className="px-2.5 py-2 text-[11.5px] text-ink-secondary">No models configured yet.</div>}
      </div>
      {instance.models.options.length > visible.length && (
        <div className="mt-1.5 text-right text-[10.5px] text-ink-secondary">
          +{instance.models.options.length - visible.length} more in the model picker
        </div>
      )}
    </div>
  );
}

export function DeepSeekHarnessSettingsView({
  instance,
  settings,
  transport,
  baseUrl,
  agentPreset,
  pairingLink,
  provider,
  search,
  candidates,
  modelId,
  modelName,
  contextWindow,
  maxTokens,
  reasoningLevels,
  loading,
  pending,
  notice,
  error,
  actionErrorCode,
  onTransportChange,
  onBaseUrlChange,
  onAgentPresetChange,
  onPairingLinkChange,
  onProviderChange,
  onSearchChange,
  onModelIdChange,
  onModelNameChange,
  onContextWindowChange,
  onMaxTokensChange,
  onReasoningLevelToggle,
  onSaveConnection,
  onPair,
  onDiscover,
  onChooseCandidate,
  onUpsert,
  onReload,
}: DeepSeekHarnessSettingsViewProps) {
  const busy = pending !== null;
  const filteredCandidates = filterDeepSeekHarnessModels(candidates, search);
  const management = settings?.modelManagement;
  const canSavePairedSettings = transport === "paired" && settings?.connection.hasDeviceCredential === true;
  const canManageModels = management?.available === true
    && management.supported
    && management.providers.length > 0
    && instance.snapshot.state === "available"
    && !(actionErrorCode && deepSeekHarnessErrorImpact(actionErrorCode).blocksModelEditor);
  const pairingLabel = settings?.connection.hasDeviceCredential ? "Pair again" : "Pair device";
  const modelBuild = buildDeepSeekHarnessModelProfile({
    id: modelId,
    name: modelName,
    contextWindow,
    maxTokens,
    reasoningLevels,
  });

  return (
    <section aria-labelledby={`${instance.instanceId}-dsh-title`} className="rounded-xl border border-hairline/45 bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#4D6BFE]/10">
          <DeepSeekHarnessMark size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div id={`${instance.instanceId}-dsh-title`} className="text-[14px] font-medium text-ink">DeepSeek Harness</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
            Connect this engine and manage its configured model catalog.
          </div>
        </div>
        <button
          type="button"
          onClick={onReload}
          disabled={busy}
          aria-label="Refresh DeepSeek Harness status"
          className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
        >
          <RefreshCw size={14} className={cn((loading || pending === "load") && "animate-spin")} />
        </button>
      </div>

      <div className="mt-3">
        <ConnectionStatus instance={instance} settings={settings} actionErrorCode={actionErrorCode} />
      </div>

      <fieldset className="mt-4" disabled={busy}>
        <legend className="text-[11.5px] font-medium text-ink">Connection mode</legend>
        <div role="group" aria-label="DeepSeek Harness connection mode" className="mt-2 flex overflow-hidden rounded-lg border border-hairline/40">
          {(["direct", "paired"] as const).map((mode, index) => (
            <button
              key={mode}
              type="button"
              aria-pressed={transport === mode}
              onClick={() => onTransportChange(mode)}
              className={cn(
                "flex-1 py-1.5 text-[12px] capitalize",
                index > 0 && "border-l border-hairline/40",
                transport === mode ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {mode === "direct" ? "Direct" : "Paired"}
            </button>
          ))}
        </div>

        {transport === "direct" ? (
          <div className="mt-3 space-y-2.5">
            <label className="block">
              <span className="text-[11.5px] text-ink-secondary">Base URL</span>
              <input
                type="url"
                value={baseUrl}
                onChange={(event) => onBaseUrlChange(event.target.value)}
                aria-label="DeepSeek Harness base URL"
                placeholder="https://dsh.example.ts.net:10443"
                spellCheck={false}
                className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[11.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
              />
            </label>
            {!isTrustedLoopback(baseUrl) && (
              <div className="rounded-lg border border-warning/20 bg-warning/8 px-2.5 py-2 text-[10.5px] leading-relaxed text-warning">
                Direct mode exposes the DSH Host API at this origin. Use it only on a trusted private network such as Tailscale.
              </div>
            )}
          </div>
        ) : (
          <div className="mt-3 space-y-2.5">
            {settings?.connection.transport === "paired" && (
              <div className="truncate rounded-lg bg-inset px-3 py-2 font-mono text-[10.5px] text-ink-secondary" title={settings.connection.baseUrl}>
                {settings.connection.baseUrl}
              </div>
            )}
            <label className="block">
              <span className="text-[11.5px] text-ink-secondary">Pairing link</span>
              <div className="mt-1 flex gap-2">
                <input
                  type="password"
                  value={pairingLink}
                  onChange={(event) => onPairingLinkChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || !pairingLink.trim()) return;
                    event.preventDefault();
                    onPair();
                  }}
                  aria-label="DeepSeek Harness pairing link"
                  placeholder="Paste the one-time DSH pairing link"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[11.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                />
                <button
                  type="button"
                  onClick={onPair}
                  disabled={!pairingLink.trim() || busy}
                  className="flex min-w-[82px] items-center justify-center gap-1.5 rounded-lg bg-[#4D6BFE] px-3 py-2 text-[11.5px] font-medium text-white hover:bg-[#405DDA] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {pending === "pair" ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                  {pairingLabel}
                </button>
              </div>
            </label>
            <p className="text-[10.5px] leading-relaxed text-ink-secondary">
              The one-time link is consumed by the server. OpenMausBot never sends the paired device credential to this interface.
            </p>
            {settings?.connection.hasDeviceCredential && (
              <p className="rounded-lg border border-hairline/35 bg-inset px-2.5 py-2 text-[10.5px] leading-relaxed text-ink-secondary">
                Reuse the existing paired device by saving this mode, or paste a fresh pairing link to replace it.
              </p>
            )}
          </div>
        )}

        <label className="mt-3 block">
          <span className="text-[11.5px] text-ink-secondary">Agent preset <span className="text-ink-secondary/65">optional</span></span>
          <input
            type="text"
            value={agentPreset}
            onChange={(event) => onAgentPresetChange(event.target.value)}
            aria-label="DeepSeek Harness agent preset"
            placeholder="Use the DSH default"
            spellCheck={false}
            className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[11.5px] text-ink placeholder:font-sans placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
        </label>

        {(transport === "direct" || canSavePairedSettings) && (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={onSaveConnection}
              disabled={busy || (transport === "direct" && !baseUrl.trim())}
              className="flex min-w-[104px] items-center justify-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              {pending === "save" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              Save settings
            </button>
          </div>
        )}
      </fieldset>

      {settings && (
        <details className="group mt-4 border-t border-hairline/35 pt-3" open={canManageModels}>
          <summary className="flex cursor-pointer list-none items-center justify-between text-[11.5px] font-medium text-ink">
            <span>Model catalog</span>
            <ChevronDown size={14} className="text-ink-secondary transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-3 space-y-4">
            <ConfiguredModels instance={instance} />

            {canManageModels ? (
              <>
                <div>
                  <div className="flex items-end gap-2">
                    <label className="min-w-0 flex-1">
                      <span className="text-[11.5px] text-ink-secondary">Provider</span>
                      <div className="relative mt-1">
                        <select
                          value={provider}
                          onChange={(event) => onProviderChange(event.target.value)}
                          aria-label="DeepSeek Harness model provider"
                          disabled={busy}
                          className="w-full appearance-none rounded-lg border border-hairline/40 bg-inset px-3 py-2 pr-8 text-[11.5px] text-ink focus:border-hairline focus:outline-none disabled:opacity-45"
                        >
                          {management.providers.map((item) => (
                            <option key={item.provider} value={item.provider}>{item.displayName}</option>
                          ))}
                        </select>
                        <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
                      </div>
                    </label>
                    <button
                      type="button"
                      onClick={onDiscover}
                      disabled={busy || !provider}
                      className="flex h-[34px] items-center gap-1.5 rounded-lg border border-hairline/40 px-3 text-[11.5px] text-ink-secondary hover:bg-raised/60 hover:text-ink disabled:opacity-45"
                    >
                      <RefreshCw size={13} className={cn(pending === "discover" && "animate-spin")} />
                      {pending === "discover" ? "Discovering models…" : "Discover"}
                    </button>
                  </div>

                  {candidates.length > 0 && (
                    <div className="mt-2.5">
                      <label className="relative block">
                        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
                        <input
                          type="search"
                          value={search}
                          onChange={(event) => onSearchChange(event.target.value)}
                          aria-label="Search discovered models"
                          placeholder="Search by model ID or name"
                          className="w-full rounded-lg border border-hairline/40 bg-inset py-2 pl-8 pr-3 text-[11.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                        />
                      </label>
                      <div className="mt-1.5 max-h-36 divide-y divide-hairline/30 overflow-y-auto rounded-lg border border-hairline/35 bg-inset">
                        {filteredCandidates.map((candidate) => (
                          <button
                            key={candidate.id}
                            type="button"
                            onClick={() => onChooseCandidate(candidate)}
                            disabled={busy}
                            className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-raised/55 disabled:opacity-45"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[11.5px] text-ink">{candidate.name ?? candidate.id}</span>
                              {candidate.name && <span className="block truncate font-mono text-[9.5px] text-ink-secondary">{candidate.id}</span>}
                            </span>
                            <Plus size={13} className="shrink-0 text-ink-secondary" />
                          </button>
                        ))}
                        {filteredCandidates.length === 0 && (
                          <div className="px-2.5 py-3 text-center text-[11px] text-ink-secondary">No discovered model matches this search.</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-hairline/35 p-3">
                  <div className="text-[11.5px] font-medium text-ink">Add or update a model</div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="col-span-2 block">
                      <span className="text-[10.5px] text-ink-secondary">Model ID</span>
                      <input
                        type="text"
                        value={modelId}
                        onChange={(event) => onModelIdChange(event.target.value)}
                        aria-label="Custom model ID"
                        placeholder="deepseek/deepseek-v3.1"
                        spellCheck={false}
                        className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 font-mono text-[11px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                      />
                    </label>
                    <label className="col-span-2 block">
                      <span className="text-[10.5px] text-ink-secondary">Display name <span className="text-ink-secondary/65">optional</span></span>
                      <input
                        type="text"
                        value={modelName}
                        onChange={(event) => onModelNameChange(event.target.value)}
                        aria-label="Custom model display name"
                        placeholder="Use the provider name"
                        className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[11px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[10.5px] text-ink-secondary">Context window <span className="text-ink-secondary/65">optional</span></span>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={8}
                        value={contextWindow}
                        onChange={(event) => onContextWindowChange(event.target.value)}
                        aria-label="Context window tokens"
                        aria-describedby={`${instance.instanceId}-dsh-context-help${modelBuild.ok || !modelBuild.errors.contextWindow ? "" : ` ${instance.instanceId}-dsh-context-error`}`}
                        aria-invalid={!modelBuild.ok && !!modelBuild.errors.contextWindow}
                        placeholder="Provider default"
                        className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 font-mono text-[11px] text-ink placeholder:font-sans placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                      />
                      <span id={`${instance.instanceId}-dsh-context-help`} className="sr-only">{MODEL_TOKENS_HELP}</span>
                      {!modelBuild.ok && modelBuild.errors.contextWindow && (
                        <span id={`${instance.instanceId}-dsh-context-error`} role="alert" className="mt-1 block text-[10px] leading-relaxed text-danger">
                          {modelBuild.errors.contextWindow}
                        </span>
                      )}
                    </label>
                    <label className="block">
                      <span className="text-[10.5px] text-ink-secondary">Maximum output <span className="text-ink-secondary/65">optional</span></span>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={8}
                        value={maxTokens}
                        onChange={(event) => onMaxTokensChange(event.target.value)}
                        aria-label="Maximum output tokens"
                        aria-describedby={`${instance.instanceId}-dsh-output-help${modelBuild.ok || !modelBuild.errors.maxTokens ? "" : ` ${instance.instanceId}-dsh-output-error`}`}
                        aria-invalid={!modelBuild.ok && !!modelBuild.errors.maxTokens}
                        placeholder="Provider default"
                        className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 font-mono text-[11px] text-ink placeholder:font-sans placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                      />
                      <span id={`${instance.instanceId}-dsh-output-help`} className="sr-only">{MODEL_TOKENS_HELP}</span>
                      {!modelBuild.ok && modelBuild.errors.maxTokens && (
                        <span id={`${instance.instanceId}-dsh-output-error`} role="alert" className="mt-1 block text-[10px] leading-relaxed text-danger">
                          {modelBuild.errors.maxTokens}
                        </span>
                      )}
                    </label>
                  </div>

                  <details className="group mt-3">
                    <summary className="flex cursor-pointer list-none items-center justify-between text-[10.5px] text-ink-secondary">
                      <span>Reasoning levels <span className="text-ink-secondary/65">optional</span></span>
                      <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
                    </summary>
                    <p className="mt-2 text-[10px] leading-relaxed text-ink-secondary">
                      Only select levels this model actually supports. None maps to DSH off; leaving every level clear keeps DSH metadata unchanged.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {EFFORT_LEVELS.map((level) => {
                        const selected = reasoningLevels.includes(level);
                        return (
                          <button
                            key={level}
                            type="button"
                            role="checkbox"
                            aria-label={`Reasoning level ${labelForEffort(level)}`}
                            aria-checked={selected}
                            onClick={() => onReasoningLevelToggle(level)}
                            disabled={busy}
                            className={cn(
                              "rounded-md border px-2 py-1 text-[10.5px]",
                              selected
                                ? "border-[#4D6BFE]/40 bg-[#4D6BFE]/12 text-[#7890FF]"
                                : "border-hairline/35 text-ink-secondary hover:bg-raised/55 hover:text-ink",
                            )}
                          >
                            {labelForEffort(level)}
                          </button>
                        );
                      })}
                    </div>
                  </details>

                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={onUpsert}
                      disabled={busy || !provider || !modelId.trim() || !modelBuild.ok}
                      className="flex min-w-[108px] items-center justify-center gap-1.5 rounded-lg bg-[#4D6BFE] px-3 py-1.5 text-[11.5px] font-medium text-white hover:bg-[#405DDA] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {pending === "upsert" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                      {pending === "upsert" ? "Updating…" : "Save model"}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-hairline/35 bg-inset px-3 py-2.5 text-[11px] leading-relaxed text-ink-secondary">
                {management?.reason ?? "Model management is unavailable right now."}
                <button type="button" onClick={onReload} disabled={busy} className="ml-2 text-accent hover:underline disabled:opacity-45">
                  Check again
                </button>
              </div>
            )}
          </div>
        </details>
      )}

      {notice && <div role="status" className="mt-3 text-[11.5px] text-success">{notice}</div>}
      {error && <div role="alert" className="mt-3 text-[11.5px] leading-relaxed text-danger">{error}</div>}
    </section>
  );
}

export function DeepSeekHarnessSettings({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStore();
  const [settings, setSettings] = useState<DeepSeekHarnessSettingsSnapshot | null>(null);
  const [transport, setTransport] = useState<DeepSeekHarnessTransport>("direct");
  const [baseUrl, setBaseUrl] = useState("");
  const [agentPreset, setAgentPreset] = useState("");
  const [pairingLink, setPairingLink] = useState("");
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<DeepSeekHarnessModelProfile[]>([]);
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [reasoningLevels, setReasoningLevels] = useState<EffortLevel[]>([]);
  const [pending, setPending] = useState<PendingAction>("load");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionErrorCode, setActionErrorCode] = useState<DeepSeekHarnessPublicErrorCode | null>(null);
  const loadGeneration = useRef(0);
  const submissionGate = useRef(createDeepSeekHarnessSubmissionGate());
  const pairingIdentity = useRef(0);
  const providerRef = useRef("");
  const modelScopeRef = useRef("");
  const modelRequestGuard = useRef(createDeepSeekHarnessModelRequestGuard());
  const actionFeedbackMachine = useRef(createDeepSeekHarnessActionFeedbackMachine());

  const syncActionFeedback = useCallback(() => {
    const feedback = actionFeedbackMachine.current.snapshot();
    setActionErrorCode(feedback.code);
    setError(feedback.error);
  }, []);

  const invalidateModelState = useCallback(() => {
    modelRequestGuard.current.invalidate();
    setCandidates([]);
    setSearch("");
    setModelId("");
    setModelName("");
    setContextWindow("");
    setMaxTokens("");
    setReasoningLevels([]);
    setNotice(null);
  }, []);

  const applySettings = useCallback((next: DeepSeekHarnessSettingsSnapshot) => {
    const nextProvider = next.modelManagement.providers.some((item) => item.provider === providerRef.current)
      ? providerRef.current
      : (next.modelManagement.providers[0]?.provider ?? "");
    const nextScope = deepSeekHarnessModelScope(next, nextProvider, pairingIdentity.current);
    if (modelScopeRef.current && modelScopeRef.current !== nextScope) invalidateModelState();
    providerRef.current = nextProvider;
    modelScopeRef.current = nextScope;
    setSettings(next);
    setTransport(next.connection.transport);
    setBaseUrl(next.connection.baseUrl);
    setAgentPreset(next.connection.agentPreset ?? "");
    setProvider(nextProvider);
  }, [invalidateModelState]);

  const load = useCallback(async (showPending = true): Promise<"success" | "failure" | "stale"> => {
    if (showPending && !submissionGate.current.claim()) return "stale";
    const generation = ++loadGeneration.current;
    const feedbackToken = actionFeedbackMachine.current.begin();
    if (showPending) setPending("load");
    syncActionFeedback();
    try {
      const next = await deepSeekHarnessActions.get(instance.instanceId);
      if (generation !== loadGeneration.current) return "stale";
      applySettings(next);
      actionFeedbackMachine.current.succeed(feedbackToken);
      syncActionFeedback();
      return "success";
    } catch (caught) {
      if (generation !== loadGeneration.current) return "stale";
      const domainError = caught instanceof DeepSeekHarnessApiError
        ? caught
        : new DeepSeekHarnessApiError("request-failed");
      actionFeedbackMachine.current.fail(feedbackToken, domainError.code);
      syncActionFeedback();
      return "failure";
    } finally {
      if (showPending) submissionGate.current.release();
      if (generation === loadGeneration.current && showPending) setPending(null);
    }
  }, [applySettings, instance.instanceId, syncActionFeedback]);

  useEffect(() => {
    let current = true;
    void runDeepSeekHarnessInitialLoad(load, () => current, () => setPending(null));
    return () => {
      current = false;
      loadGeneration.current += 1;
      modelRequestGuard.current.invalidate();
    };
  }, [load]);

  const run = useCallback(async (kind: Exclude<PendingAction, "load" | null>, action: () => Promise<void>) => {
    if (!submissionGate.current.claim()) return;
    const feedbackToken = actionFeedbackMachine.current.begin();
    setPending(kind);
    setNotice(null);
    syncActionFeedback();
    try {
      await action();
    } catch (caught) {
      const domainError = caught instanceof DeepSeekHarnessApiError
        ? caught
        : new DeepSeekHarnessApiError("request-failed");
      const impact = deepSeekHarnessErrorImpact(domainError.code);
      if (impact.invalidateModels) invalidateModelState();
      if (impact.refreshSettings) {
        const [settingsRefresh] = await Promise.all([
          load(false),
          refreshInstances().then(() => true, () => false),
        ]);
        if (settingsRefresh === "failure") {
          const refreshFailure = actionFeedbackMachine.current.begin();
          actionFeedbackMachine.current.fail(refreshFailure, domainError.code);
          syncActionFeedback();
        }
        return;
      }
      if (actionFeedbackMachine.current.fail(feedbackToken, domainError.code)) syncActionFeedback();
    } finally {
      submissionGate.current.release();
      setPending(null);
    }
  }, [invalidateModelState, load, refreshInstances, syncActionFeedback]);

  const saveConnection = () => void run("save", async () => {
    const patch: DeepSeekHarnessConnectionPatch = {
      transport,
      agentPreset: agentPreset.trim() || null,
    };
    if (transport === "direct") patch.baseUrl = baseUrl.trim();
    await deepSeekHarnessActions.patch(instance.instanceId, patch);
    await Promise.all([load(false), refreshInstances()]);
    setNotice("DeepSeek Harness settings saved.");
  });

  const pair = () => {
    if (submissionGate.current.isBusy()) return;
    const link = pairingLink.trim();
    if (!link) return;
    setPairingLink("");
    void run("pair", async () => {
      await deepSeekHarnessActions.pair(instance.instanceId, link);
      pairingIdentity.current += 1;
      invalidateModelState();
      await Promise.all([load(false), refreshInstances()]);
      setNotice("Device paired. The one-time link was not stored.");
    });
  };

  const discover = () => void run("discover", async () => {
    const scope = modelScopeRef.current;
    const token = modelRequestGuard.current.issue(scope);
    const selectedProvider = provider;
    const result = await deepSeekHarnessActions.discover(instance.instanceId, selectedProvider);
    modelRequestGuard.current.commit(token, modelScopeRef.current, () => {
      setCandidates(result.models);
      setSearch("");
      setNotice(`${result.models.length} model${result.models.length === 1 ? "" : "s"} discovered.`);
    });
  });

  const chooseCandidate = (candidate: DeepSeekHarnessModelProfile) => {
    const draft = modelDraftFromCandidate(candidate);
    setModelId(draft.id);
    setModelName(draft.name);
    setContextWindow(draft.contextWindow);
    setMaxTokens(draft.maxTokens);
    setReasoningLevels(draft.reasoningLevels);
  };

  const upsert = () => void run("upsert", async () => {
    const built = buildDeepSeekHarnessModelProfile({
      id: modelId,
      name: modelName,
      contextWindow,
      maxTokens,
      reasoningLevels,
    });
    if (!built.ok || !built.model.id) return;
    const scope = modelScopeRef.current;
    const token = modelRequestGuard.current.issue(scope);
    await deepSeekHarnessActions.upsert(instance.instanceId, { provider, model: built.model });
    if (!modelRequestGuard.current.accept(token, modelScopeRef.current)) return;
    await refreshInstances();
    setModelId("");
    setModelName("");
    setContextWindow("");
    setMaxTokens("");
    setReasoningLevels([]);
    setNotice("Model catalog refreshed.");
  });

  return (
    <DeepSeekHarnessSettingsView
      instance={instance}
      settings={settings}
      transport={transport}
      baseUrl={baseUrl}
      agentPreset={agentPreset}
      pairingLink={pairingLink}
      provider={provider}
      search={search}
      candidates={candidates}
      modelId={modelId}
      modelName={modelName}
      contextWindow={contextWindow}
      maxTokens={maxTokens}
      reasoningLevels={reasoningLevels}
      loading={pending === "load"}
      pending={pending}
      notice={notice}
      error={error}
      actionErrorCode={actionErrorCode}
      onTransportChange={setTransport}
      onBaseUrlChange={setBaseUrl}
      onAgentPresetChange={setAgentPreset}
      onPairingLinkChange={setPairingLink}
      onProviderChange={(next) => {
        if (next === providerRef.current) return;
        invalidateModelState();
        providerRef.current = next;
        if (settings) {
          modelScopeRef.current = deepSeekHarnessModelScope(settings, next, pairingIdentity.current);
        }
        setProvider(next);
      }}
      onSearchChange={setSearch}
      onModelIdChange={setModelId}
      onModelNameChange={setModelName}
      onContextWindowChange={setContextWindow}
      onMaxTokensChange={setMaxTokens}
      onReasoningLevelToggle={(level) => setReasoningLevels((current) => current.includes(level)
        ? current.filter((candidate) => candidate !== level)
        : EFFORT_LEVELS.filter((candidate) => candidate === level || current.includes(candidate)))}
      onSaveConnection={saveConnection}
      onPair={pair}
      onDiscover={discover}
      onChooseCandidate={chooseCandidate}
      onUpsert={upsert}
      onReload={() => void load()}
    />
  );
}
