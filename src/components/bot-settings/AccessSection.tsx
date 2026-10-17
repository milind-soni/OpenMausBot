import { useEffect, useState } from "react";
import { browserUnavailableReason } from "@/lib/feature-flags";
import { ChevronDown, ChevronRight, FolderOpen, Plus } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";
import { useBotEditor } from "./BotEditorContext";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { mcpServersForBot, useMcpServers } from "@/lib/mcp-servers";
import { placeFacts, placeViewFor, usePlaceSeat } from "@/lib/place-view";
import { shortPath } from "@/lib/short-path";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { CloudBackendPicker } from "../CloudBackendPicker";
import { ConfirmDialog } from "../ConfirmDialog";
import { Switch } from "../SettingsPrimitives";
import { ProposalStatus } from "./ProposalStatus";
import { ToolSelectionCard } from "./ToolSelectionCard";
import { useCloudPlan } from "../ProIntroduction";
import { xResearchAction } from "@/lib/cloud-plan";
import { HIGHLEVEL_SLUG } from "@/lib/highlevel-sign-in";
import { useBotApps } from "./useBotApps";
import {
  classifyConnectorTool,
  connectorServiceAccess,
  withServiceGrant,
  type ConnectorVerb,
} from "@/lib/connector-grants";
import { inputCls } from "./field";
import type { ConnectorScope, ConnectorScopes } from "../../../shared/connector-scopes";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";

/**
 * Claude keeps sessions per project folder, so the server pins each task's folder on its first turn. PATCHed directly,
 * not via updateBot: the server validates the path, and a rejected folder must not stick in local state.
 */
export function WorkingFolder({ bot }: { bot: Bot }) {
  const { request: api } = useBotEditor();
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const pinned = task?.cwd;
  const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== bot.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.ogb?.pickFolder?.(bot.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Working folder</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">Where this bot runs its shell and file tools.</div>
      <ProposalStatus bot={bot} kind="chief" />
      {canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">Private bot folder</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> Choose…
          </button>
          {bot.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              Clear
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save((draft ?? bot.cwd ?? "").trim() || null);
          }}
        >
          <input
            className={cn(inputCls, "font-mono text-[12.5px]")}
            placeholder="Private bot folder — or an absolute path"
            value={draft ?? bot.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            Save
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          New tasks start here. This task is pinned to {pinned ? <span className="font-mono">{shortPath(pinned, home)}</span> : "the home folder"} — start a new task to use the new folder.
        </div>
      )}
    </div>
  );
}

/**
 * Absent list = all enabled; the first flip writes an explicit list so servers added later never silently reach this
 * bot.
 */
export function McpServersCard({ bot, patch }: { bot: Bot; patch: (patch: { mcpServers: string[] | null }) => void }) {
  const { dispatch } = useStore();
  const { servers, error, refresh } = useMcpServers();
  const mounted = new Set((servers ? mcpServersForBot(servers, bot.mcpServers) : []).map((server) => server.name));
  const usesAll = bot.mcpServers == null;

  const toggle = (name: string) => {
    if (!servers || bot.busy || error) return;
    const current = usesAll ? servers.filter((server) => server.enabled).map((server) => server.name) : [...(bot.mcpServers ?? [])];
    const next = current.includes(name) ? current.filter((item) => item !== name) : [...current, name];
    patch({ mcpServers: next });
  };
  const openPlugins = () => {
    dispatch({ type: "toggleSettings", open: false });
    dispatch({ type: "togglePlugins", open: true, surface: "mcp" });
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[15px] font-medium text-ink">{t("connectors.tab.mcp")}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {t("botAccess.mcpDescription")}
          </div>
          <ProposalStatus bot={bot} kind="owner" />
        </div>
      </div>
      {error && (
        <div role="alert" className="mt-3 text-[12px] text-danger">
          {t("botAccess.mcpRefreshError")} <button type="button" onClick={() => void refresh()} className="underline">{t("connectors.action.retry")}</button>
        </div>
      )}
      {servers === null ? !error && (
        <div className="mt-3 text-[12px] text-ink-secondary">{t("mcp.loading")}</div>
      ) : servers.length === 0 ? (
        <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">{t("botAccess.mcpEmpty")}</div>
      ) : (
        <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
          {servers.map((server) => (
            <div key={server.name} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12.5px] text-ink">{server.name}</div>
                {!server.enabled && <div className="text-[11.5px] text-ink-secondary">{t("botAccess.mcpDisabled")}</div>}
              </div>
              <Switch
                checked={mounted.has(server.name)}
                disabled={!server.enabled || !!bot.busy || error}
                aria-label={t("botAccess.mcpAllow", { name: server.name })}
                onClick={() => toggle(server.name)}
                className="disabled:cursor-not-allowed"
              />
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={openPlugins} className="flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover">
          <Plus size={14} /> {t("botAccess.mcpAdd")}
        </button>
        {!usesAll && servers && servers.length > 0 && (
          <button type="button" disabled={!!bot.busy || error} onClick={() => { if (!bot.busy && !error) patch({ mcpServers: null }); }} className="rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
            {t("botAccess.mcpUseAll")}
          </button>
        )}
      </div>
      {bot.busy && <p className="mt-2 text-[12px] text-ink-secondary">{t("botAccess.mcpBusy")}</p>}
    </div>
  );
}

interface ToolListing {
  name: string;
  description?: string;
}

let connectorToolsCache: { at: number; services: Record<string, ToolListing[]> } | null = null;
let connectorToolsRequest: Promise<Record<string, ToolListing[]>> | null = null;
const CONNECTOR_TOOLS_CACHE_MS = 60_000;

function preloadConnectorTools(force = false): Promise<Record<string, ToolListing[]>> {
  if (!force && connectorToolsCache && Date.now() - connectorToolsCache.at < CONNECTOR_TOOLS_CACHE_MS) {
    return Promise.resolve(connectorToolsCache.services);
  }
  if (connectorToolsRequest) return connectorToolsRequest;
  connectorToolsRequest = api<{ configured?: boolean; services?: Record<string, ToolListing[]> }>("/api/connectors/tools")
    .then((response) => {
      const services = response.services ?? {};
      if (response.configured) connectorToolsCache = { at: Date.now(), services };
      return services;
    })
    .finally(() => {
      connectorToolsRequest = null;
    });
  return connectorToolsRequest;
}

const VERB_ORDER: ConnectorVerb[] = ["read", "draft", "send", "modify", "delete"];
const VERB_LABELS: Record<ConnectorVerb, LocaleKey> = {
  read: "botAccess.grants.verb.read",
  draft: "botAccess.grants.verb.draft",
  send: "botAccess.grants.verb.send",
  modify: "botAccess.grants.verb.modify",
  delete: "botAccess.grants.verb.delete",
};

/**
 * A grants record this build cannot parse renders read-only, never a guess that could destroy fields a newer server
 * understands.
 */
function ConnectorToolsGrants({
  bot,
  patch,
  slugs,
}: {
  bot: Bot;
  patch: ReturnType<typeof useBotSettingsDerived>["patch"];
  slugs: string[];
}) {
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tools, setTools] = useState<Record<string, ToolListing[]> | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [lastExplicit, setLastExplicit] = useState<Record<string, string[]>>({});
  /**
   * The first grant creates the grants record, which limits every other connected app to no tools: confirm it first.
   */
  const [confirmFirstGrant, setConfirmFirstGrant] = useState<{ slug: string; tools: "*" | string[] } | null>(null);

  useEffect(() => {
    if (!openSlug || tools || toolsError) return;
    let cancelled = false;
    preloadConnectorTools()
      .then((services) => {
        if (!cancelled) setTools(services);
      })
      .catch((e: unknown) => {
        if (!cancelled) setToolsError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [openSlug, tools, toolsError]);

  const record = bot.connectorTools;
  const recordExists = record !== undefined && record !== null;
  const selectedFor = (slug: string): string[] => {
    const grant = record?.[slug];
    return grant && grant.tools !== "*" ? grant.tools : [];
  };

  const apply = (slug: string, next: { tools: "*" | string[] } | null) => {
    const value = withServiceGrant(record, slug, next);
    if (value === undefined) return;
    patch({ connectorTools: value });
  };

  const toggleTool = (slug: string, name: string) => {
    const selected = selectedFor(slug);
    const next = selected.includes(name) ? selected.filter((entry) => entry !== name) : [...selected, name];
    if (!next.length) {
      apply(slug, null);
      return;
    }
    setLastExplicit((prev) => ({ ...prev, [slug]: next }));
    if (!recordExists) {
      setConfirmFirstGrant({ slug, tools: next });
      return;
    }
    apply(slug, { tools: next });
  };

  const allForService = (slug: string) => {
    if (!recordExists) {
      setConfirmFirstGrant({ slug, tools: "*" });
      return;
    }
    const selected = selectedFor(slug);
    if (selected.length) setLastExplicit((prev) => ({ ...prev, [slug]: selected }));
    apply(slug, { tools: "*" });
  };

  const leaveAllForService = (slug: string) => {
    const remembered = lastExplicit[slug];
    if (remembered && remembered.length) apply(slug, { tools: remembered });
    else apply(slug, null);
  };

  if (!slugs.length) {
    return <div className="mt-3 text-[11.5px] text-ink-secondary">{t("botAccess.grants.noApps")}</div>;
  }

  return (
    <div className="mt-3">
      <div className="text-[12px] font-medium text-ink">{t("botAccess.grants.header")}</div>
      <div className="mt-0.5 text-[11.5px] text-ink-secondary">{t("botAccess.grants.hint")}</div>
      <div className="mt-2 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
        {slugs.map((slug) => {
          const access = connectorServiceAccess(record, slug);
          const open = openSlug === slug;
          const grant = record?.[slug];
          const isAll = access.level === "all" && recordExists && grant?.tools === "*";
          const serviceTools = tools?.[slug] ?? [];
          const selected = selectedFor(slug);
          const query = search.trim().toLowerCase();
          const matches = query
            ? serviceTools.filter((tool) => tool.name.toLowerCase().includes(query)
              || (tool.description ?? "").toLowerCase().includes(query))
            : serviceTools;
          const verbCounts = new Map<ConnectorVerb, string[]>();
          for (const tool of serviceTools) {
            const verb = classifyConnectorTool(tool.name);
            if (!verb) continue;
            const bucket = verbCounts.get(verb) ?? [];
            bucket.push(tool.name);
            verbCounts.set(verb, bucket);
          }
          return (
            <div key={slug}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => {
                  setOpenSlug(open ? null : slug);
                  setSearch("");
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-control/60"
              >
                {open ? <ChevronDown size={14} className="shrink-0 text-ink-secondary" /> : <ChevronRight size={14} className="shrink-0 text-ink-secondary" />}
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{slug}</span>
                <span className="shrink-0 text-[11.5px] text-ink-secondary">
                  {!access.editable
                    ? t("botAccess.grants.custom")
                    : access.level === "all"
                      ? t("botAccess.grants.allTools")
                      : access.level === "none"
                        ? t("botAccess.grants.noTools")
                        : t("botAccess.grants.toolCount", { count: access.count })}
                </span>
              </button>
              {open && (
                <div className="border-t border-hairline/40 bg-inset/40 px-3 py-3">
                  {!access.editable ? (
                    <div className="text-[11.5px] leading-relaxed text-ink-secondary">
                      {t("botAccess.grants.uneditable")}
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => (isAll ? leaveAllForService(slug) : allForService(slug))}
                          className={cn(
                            "rounded-full px-2.5 py-1 text-[11.5px] font-medium",
                            isAll ? "bg-accent/15 text-accent-text" : "bg-control text-ink hover:bg-raised-hover",
                          )}
                        >
                          {t("botAccess.grants.allTools")}
                        </button>
                        {recordExists && (
                          <button
                            type="button"
                            onClick={() => patch({ connectorTools: null })}
                            className="rounded-full bg-control px-2.5 py-1 text-[11.5px] font-medium text-ink hover:bg-raised-hover"
                          >
                            {t("botAccess.grants.allApps")}
                          </button>
                        )}
                      </div>
                      {!recordExists && (
                        <div className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
                          {t("botAccess.grants.firstGrantWarning")}
                        </div>
                      )}
                      {toolsError ? (
                        <div className="mt-2 text-[11.5px] text-ink-secondary">
                          {t("botAccess.grants.loadError")}{" "}
                          <button
                            type="button"
                            className="underline"
                            onClick={() => {
                              setToolsError(null);
                              setTools(null);
                              void preloadConnectorTools(true).then(() => undefined).catch(() => undefined);
                            }}
                          >
                            {t("botAccess.grants.retry")}
                          </button>
                        </div>
                      ) : tools === null ? (
                        <div className="mt-2 text-[11.5px] text-ink-secondary">{t("botAccess.grants.loading")}</div>
                      ) : serviceTools.length === 0 ? (
                        <div className="mt-2 text-[11.5px] text-ink-secondary">{t("botAccess.grants.noListing")}</div>
                      ) : (
                        <>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {VERB_ORDER.filter((verb) => verbCounts.has(verb)).map((verb) => {
                              const names = verbCounts.get(verb) ?? [];
                              return (
                                <button
                                  key={verb}
                                  type="button"
                                  title={t("botAccess.grants.verbHint")}
                                  onClick={() => {
                                    const next = [...new Set([...selected, ...names])];
                                    setLastExplicit((prev) => ({ ...prev, [slug]: next }));
                                    if (!recordExists) {
                                      setConfirmFirstGrant({ slug, tools: next });
                                      return;
                                    }
                                    apply(slug, { tools: next });
                                  }}
                                  className="rounded-full bg-control px-2.5 py-1 text-[11px] text-ink hover:bg-raised-hover"
                                >
                                  {t(VERB_LABELS[verb])} · {names.length}
                                </button>
                              );
                            })}
                          </div>
                          <input
                            className={cn(inputCls, "mt-2")}
                            placeholder={t("botAccess.grants.search")}
                            aria-label={t("botAccess.grants.search")}
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                          />
                          <div className="mt-2 max-h-64 space-y-0.5 overflow-y-auto">
                            {matches.map((tool) => {
                              const checked = isAll || selected.includes(tool.name);
                              return (
                                <label key={tool.name} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-control/60">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={isAll}
                                    onChange={() => toggleTool(slug, tool.name)}
                                    className="mt-0.5"
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate font-mono text-[11.5px] text-ink" title={tool.name}>{tool.name}</span>
                                    {tool.description && (
                                      <span className="block truncate text-[11px] text-ink-secondary" title={tool.description}>
                                        {tool.description}
                                      </span>
                                    )}
                                  </span>
                                </label>
                              );
                            })}
                            {matches.length === 0 && (
                              <div className="px-1.5 py-2 text-[11.5px] text-ink-secondary">{t("botAccess.grants.noMatches")}</div>
                            )}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <ConfirmDialog
        open={confirmFirstGrant !== null}
        title={t("botAccess.grants.firstGrantTitle", { service: confirmFirstGrant?.slug ?? "" })}
        body={t("botAccess.grants.firstGrantBody", { service: confirmFirstGrant?.slug ?? "" })}
        confirmLabel={t("botAccess.grants.saveGrant")}
        onCancel={() => setConfirmFirstGrant(null)}
        onConfirm={() => {
          const pending = confirmFirstGrant;
          setConfirmFirstGrant(null);
          if (!pending) return;
          apply(pending.slug, { tools: pending.tools });
        }}
      />
    </div>
  );
}

/** Research through treg (the X tools and the general research tools): on for every bot whenever this server holds a
 * treg key or a Cloud plan's research credential, and switchable off per bot. */
function ResearchCard({ bot, patch }: { bot: Bot; patch: (patch: { xResearch: boolean }) => void }) {
  const { state, dispatch } = useStore();
  const connecting = xResearchAction(useCloudPlan()?.view ?? null) === "connecting" && state.config?.xResearch?.unavailable !== true;
  const ownKey = state.config?.treg?.configured === true, included = state.config?.xResearch?.included === true;
  const available = ownKey || included;
  const on = bot.xResearch !== false;
  const line = !available ? t(connecting ? "research.connecting" : "research.addKey")
    : !on ? t("research.off") : t(ownKey ? "research.ownOn" : "research.planOn");
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4" data-testid="access-x-research">
      <div>
        <div className="text-[15px] font-medium text-ink">{t("research.title")}</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">{line}</div>
        {!available && !connecting && (
          <button type="button" className="ui-button mt-2" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}>
            {t("research.openKeys")}
          </button>
        )}
      </div>
      <Switch
        checked={available && on}
        aria-label={t("research.switch")}
        disabled={!available}
        onClick={() => patch({ xResearch: !on })}
        className="disabled:cursor-not-allowed"
      />
    </div>
  );
}

function RecordStepsRow({ on, browserOn, myChrome, onChange }: { on: boolean; browserOn: boolean; myChrome: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="mt-3 flex items-center justify-between gap-4 border-t border-hairline/40 pt-3">
      <div>
        <div className="text-[13.5px] font-medium text-ink">{t("botAccess.recordSteps.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-ink-secondary">
          {!browserOn ? t("botAccess.recordSteps.needsBrowser") : on ? t("botAccess.recordSteps.on") : t("botAccess.recordSteps.off")}
          {browserOn && on && myChrome ? ` ${t("botAccess.recordSteps.myChrome")}` : ""}
        </div>
      </div>
      <Switch
        checked={on && browserOn}
        aria-label={t("botAccess.recordSteps.title")}
        disabled={!browserOn}
        onClick={() => onChange(!on)}
        className="disabled:cursor-not-allowed"
      />
    </div>
  );
}

export function cloudPreferenceShown(bot: Pick<Bot, "computer">, config: { cloudHome?: boolean } | null | undefined): boolean {
  return (!bot.computer || bot.computer === "cloud") && !config?.cloudHome;
}

export function CloudPreference({ bot, patch }: { bot: Bot; patch: ReturnType<typeof useBotSettingsDerived>["patch"] }) {
  const { state } = useStore();
  if (!cloudPreferenceShown(bot, state.config)) return null;
  return (
    <>
      {!bot.computer && (
        <div className="mt-3 rounded-lg bg-inset px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-secondary">
          <span className="font-medium text-ink">Auto cloud preference.</span>{" "}
          This chooses what Auto may reuse during a task; viewing settings does not create or wake a computer.
        </div>
      )}
      <CloudBackendPicker
        value={bot.cloudBackend ?? "box"}
        onChange={(backend) => patch({ cloudBackend: backend })}
      />
      {!bot.computer && bot.cloudBackend === "vps" && (
        <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] text-ink">Start VPS automatically</div>
            <div className="mt-0.5 text-[11.5px] text-ink-secondary">
              Allow Auto to create or wake this bot's managed container when needed.
            </div>
          </div>
          <Switch
            checked={Boolean(bot.autoStartVps)}
            aria-label="Start VPS automatically"
            onClick={() => patch({ autoStartVps: !bot.autoStartVps })}
          />
        </div>
      )}
    </>
  );
}

export type AccessPart = "worksOn" | "folder" | "apps" | "xResearch" | "mcp" | "tools" | "browser" | "webhooks" | "always";

export function AccessSection({
  bot,
  derived,
  parts,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  parts?: readonly AccessPart[];
}) {
  const { draft } = useBotEditor();
  const { state, dispatch } = useStore();
  const {
    patch,
    canUseConnectedApps,
    connectedAppsConfigured,
    connectedAppsEnabled,
    connectorGrantState,
    canUseBrowser,
    desktopBrowser,
    browserBlockedOnWindows,
    browserFeature,
    browserAllowed,
    browserEnabled,
  } = derived;
  const browserInstallable = state.config?.browserEngine?.installable === true;
  const { capabilities } = useDesktopCapabilities();
  const placeSeat = usePlaceSeat(state.config, capabilities.host?.platform ?? "other");
  const worksOn = placeViewFor(placeFacts({
    bot, place: bot.computer ?? "auto", seat: placeSeat, config: state.config, instances: state.instances,
  }));
  // The same list the Vault tab shows: Composio's connected accounts plus the native HighLevel connection.
  const apps = useBotApps(bot);
  const inventoryReady = apps.phase === "ready";
  const connectedSlugs = apps.connectedSlugs;
  const appLabels = Object.fromEntries(apps.apps.map((app) => [app.slug, app.label]));

  const webhooks = state.webhooks.filter((webhook) => webhook.botId === bot.id);
  const alwaysAllow = bot.alwaysAllow ?? [];
  const shows = (part: AccessPart) => !parts || parts.includes(part);

  return (
    <div className="flex flex-col gap-4">
      {shows("worksOn") && <div className="rounded-xl bg-card p-4" data-testid="access-works-on">
        <div className="text-[15px] font-medium text-ink">{t("access.worksOn", { name: bot.name, short: worksOn.short })}</div>
        <ProposalStatus bot={bot} kind="owner" />
        <button
          type="button"
          onClick={() => {
            dispatch({ type: "toggleSettings", open: false });
            dispatch({ type: "toggleComputer", open: true });
          }}
          className="mt-3 rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
        >
          {t("place.action.openComputerPanel")}
        </button>
        <CloudPreference bot={bot} patch={patch} />
      </div>}

      {shows("folder") && <WorkingFolder bot={bot} />}

      {shows("apps") && <div className="rounded-xl bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[15px] font-medium text-ink">Connected apps</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {!connectedAppsConfigured
                ? "Connect apps in App Settings before giving this bot access."
                : !canUseConnectedApps
                  ? "This bot's current model cannot use connected apps."
                  : connectedAppsEnabled
                    ? connectorGrantState === "partial"
                      ? "Tool access is tailored per app. Expand an app below to edit its tools."
                      : connectorGrantState === "none"
                        ? "Every connected app is currently limited to no tools. Expand an app to grant tools."
                        : "Let this bot use your connected Gmail, Calendar, Slack, and other apps."
                    : "Keep your connected apps unavailable to this bot."}
            </div>
            <ProposalStatus bot={bot} kind="owner" />
          </div>
          <Switch
            checked={connectedAppsEnabled}
            aria-label="Allow this bot to use connected apps"
            disabled={
              !connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)
            }
            onClick={() => patch({ composio: !connectedAppsEnabled })}
            title={
              !connectedAppsEnabled && !connectedAppsConfigured
                ? "Connect apps in App Settings first"
                : !connectedAppsEnabled && !canUseConnectedApps
                  ? "This model cannot use connected apps"
                  : undefined
            }
            className="disabled:cursor-not-allowed"
          />
        </div>
        {connectedAppsEnabled && inventoryReady && (
          <>
            {!draft && <ConnectorScopesControl connectedSlugs={connectedSlugs} labels={appLabels} scopes={bot.connectorScopes} onChange={(connectorScopes) => patch({ connectorScopes })} />}
            {/* Tool-level grants list Composio's tools; HighLevel's tools are scoped by read/write above. */}
            <ConnectorToolsGrants bot={bot} patch={patch} slugs={connectedSlugs.filter((slug) => slug !== HIGHLEVEL_SLUG)} />
          </>
        )}
        {connectedAppsEnabled && connectedAppsConfigured && (
          <button
            type="button"
            onClick={() => {
              dispatch({ type: "toggleSettings", open: false });
              dispatch({ type: "togglePlugins", open: true, surface: "apps" });
            }}
            className="mt-3 flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
          >
            <Plus size={14} /> {t("botAccess.connectApp")}
          </button>
        )}
      </div>}

      {shows("mcp") && <McpServersCard bot={bot} patch={patch} />}
      {shows("tools") && <ToolSelectionCard key={bot.id} bot={bot} engineKind={derived.engine?.driverKind} />}

      {shows("browser") && <div className="rounded-xl bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[15px] font-medium text-ink">Browser</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {!desktopBrowser
                ? browserBlockedOnWindows && !browserInstallable
                  ? "Not available on this Windows machine yet: install the browser engine with `openmausbot browser install`."
                  : browserUnavailableReason(state.config)
                : !browserFeature
                  ? "The built-in browser is switched off under App Settings → Computers."
                  : !canUseBrowser
                    ? "This bot's current model cannot use the built-in browser."
                    : bot.computer === "off"
                      ? "Works on is set to Off, so this bot has no browser. Choose another place in the Computer panel to give it one."
                      : browserEnabled
                        ? "This bot has its own browser with its own logins."
                        : "Keep the built-in browser unavailable to this bot."}
            </div>
            <ProposalStatus bot={bot} kind="owner" />
          </div>
          <Switch
            checked={browserEnabled && bot.computer !== "off"}
            aria-label="Give this bot a built-in browser"
            disabled={
              bot.computer === "off" ||
              (!browserEnabled && ((!desktopBrowser && !browserInstallable) || !browserFeature || !canUseBrowser))
            }
            onClick={() => patch({ browser: !browserAllowed })}
            title={bot.computer === "off" ? "Works on is set to Off, so this bot has no browser" : undefined}
            className="disabled:cursor-not-allowed"
          />
        </div>
        {!draft && (
          <RecordStepsRow
            on={bot.recordBrowserSteps === true}
            browserOn={browserEnabled && bot.computer !== "off"}
            myChrome={state.config?.browserEngine?.myChrome === true && (state.config?.browserProfiles ?? []).some((profile) => profile.id === bot.browserProfile && profile.browser === "chrome")}
            onChange={(recordBrowserSteps) => patch({ recordBrowserSteps })}
          />
        )}
      </div>}

      {!draft && shows("xResearch") && <ResearchCard bot={bot} patch={patch} />}

      {!draft && shows("webhooks") && <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Webhooks</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">Inbound triggers wired to this bot.</div>
        <ProposalStatus bot={bot} kind="owner" />
        {webhooks.length === 0 ? (
          <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">No webhooks for this bot.</div>
        ) : (
          <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
            {webhooks.map((webhook) => (
              <div key={webhook.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{webhook.name}</span>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    webhook.enabled ? "bg-accent/15 text-accent-text" : "bg-control text-ink-secondary",
                  )}
                >
                  {webhook.enabled ? "Active" : "Paused"}
                </span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-ink-secondary">
                  {webhook.deliveryCount} deliveries
                </span>
              </div>
            ))}
          </div>
        )}
      </div>}

      {!draft && shows("always") && <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Always allowed</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">Tools this bot no longer asks about.</div>
        <ProposalStatus bot={bot} kind="owner" />
        {alwaysAllow.length === 0 ? (
          <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">Nothing standing yet.</div>
        ) : (
          <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
            {alwaysAllow.map((entry) => (
              <div key={entry} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{entry}</span>
                <button
                  type="button"
                  aria-label={`Remove ${entry} from always allowed`}
                  onClick={() => patch({ alwaysAllow: alwaysAllow.filter((key) => key !== entry) })}
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>}

    </div>
  );
}

function ConnectorScopesControl({ connectedSlugs, labels = {}, scopes, onChange }: {
  connectedSlugs: string[];
  /** display names by slug; a slug without one shows as itself */
  labels?: Record<string, string>;
  scopes: ConnectorScopes | undefined;
  onChange: (scopes: ConnectorScopes | null) => void;
}) {
  const limited = scopes !== undefined;
  const slugs = [...new Set([...connectedSlugs, ...Object.keys(scopes?.apps ?? {})])].sort();
  const setScope = (slug: string, scope: ConnectorScope | null) => {
    const apps = { ...scopes?.apps };
    if (scope) apps[slug] = scope;
    else delete apps[slug];
    onChange({ apps });
  };
  return <div className="mt-3">
    <div className="flex items-center justify-between gap-4">
      <div className="text-[13px] text-ink-secondary">
        {limited ? "Only the apps allowed below, at the level set for each. Everything else is off for this bot." : "No app-level limits. The tool grants below still apply."}
      </div>
      <Switch checked={limited} aria-label="Limit this bot to specific apps" onClick={() => onChange(limited ? null : { apps: {} })} />
    </div>
    {limited && <div className="mt-2 flex flex-col divide-y divide-hairline/20 rounded-lg bg-inset">
      {!slugs.length && <div className="px-3 py-2 text-[11.5px] text-ink-secondary">No apps connected yet. Connect one, then allow it here.</div>}
      {slugs.map((slug) => <div key={slug} className="flex flex-wrap items-center justify-between gap-3 px-3 py-1.5">
        <span className="min-w-0 text-[13px] text-ink">{labels[slug] ?? slug}{!connectedSlugs.includes(slug) && <span className="ml-2 text-[10.5px] text-ink-secondary">not connected</span>}</span>
        <div className="flex shrink-0 gap-0.5 rounded-md bg-card p-0.5" role="group" aria-label={`${slug} access`}>
          {([[null, "Off", "This bot cannot use it."], ["read", "Read", "Search, fetch, and list only."], ["write", "Read & write", "Tool grants and sending limits still apply."]] as const).map(([value, label, hint]) =>
            <button key={label} type="button" title={hint} aria-pressed={(scopes?.apps[slug] ?? null) === value} onClick={() => setScope(slug, value)}
              className={cn("rounded px-2 py-0.5 text-[11.5px] font-medium", (scopes?.apps[slug] ?? null) === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink")}>{label}</button>)}
        </div>
      </div>)}
    </div>}
  </div>;
}
