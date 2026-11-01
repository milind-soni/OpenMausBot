import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  FlaskConical,
  Globe,
  Loader2,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2,
} from "lucide-react";

import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { updateMcpServers } from "@/lib/mcp-servers";
import { completeMcpSignIn, mcpSignInLink, runMcpSignIn, type McpSignInStatus } from "@/lib/mcp-sign-in";
import { api, useStore } from "@/state/store";

import { McpAppsSwitch } from "./McpAppsSwitch";
import { Switch } from "./SettingsPrimitives";
import { ClaudeCodeSwitches } from "./ClaudeCodeSwitches";
import { WhopIcon } from "./WhopIcon";
import type { McpMessage } from "./McpResultBudgetField";
import { McpServerEditor, type McpServerSubmission } from "./McpServerEditor";
import { isRemoteMcpListing, type McpServerListing } from "./mcp-draft";
import { WHOP_MCP_URL, isWhopServer, whopServerName } from "@/lib/whop-integration";
import { POSTIZ_SERVER } from "../../shared/postiz";
import { openBotSettings } from "./bot-panel/panel-link";

export interface ProbeResult {
  ok: boolean;
  tools?: Array<{ name: string; description?: string }>;
  total?: number;
  error?: string;
  auth?: "required";
  /** `keys`: the server refused the headers it was sent; `unreachable` and `timeout` may pass on a second try. */
  reason?: "keys" | "unreachable" | "timeout";
  status?: number;
  /** This panel's own note: the test ran right after the server was saved, so a failure means it was saved but off. */
  saved?: boolean;
}

/** A passing test after a save switches the server on by itself. A click on its switch this soon after was aimed at the
 * Off the person saw, so it keeps the server on instead of switching it straight back off. */
export const SWITCH_SETTLE_MS = 1_500;

async function toolsCheck(
  name: string,
  request: (path: string, init?: RequestInit) => Promise<ProbeResult>,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  try {
    return await request(`/api/mcp/servers/${encodeURIComponent(name)}/test`, { method: "POST", signal });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause), reason: "unreachable" };
  }
}

export async function signedInToolsCheck(
  name: string,
  request: (path: string, init?: RequestInit) => Promise<ProbeResult>,
  signal: AbortSignal,
): Promise<ProbeResult> {
  const tested = await toolsCheck(name, request, signal);
  if (tested.ok) return tested;
  const reason = (tested.error ?? "").trim();
  return { ...tested, error: t("whop.testFailed", { reason: reason && !/[.!?]$/.test(reason) ? `${reason}.` : reason }) };
}

/** Security: names the headers, never their values. */
function failureReason(server: McpServerListing, result: ProbeResult): string {
  if (result.reason !== "keys" || !isRemoteMcpListing(server)) return result.error ?? "";
  const reason = result.status ? `HTTP ${result.status}` : "unauthorized";
  if (!server.headerKeys.length) return t("mcp.check.keysNeeded", { reason });
  return t("mcp.check.keysRefused", { reason, names: new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(server.headerKeys) });
}

function connectedLabel(result: ProbeResult): string {
  const count = Math.max(result.total ?? 0, result.tools?.length ?? 0);
  if (!count) return t("mcp.check.connectedNone");
  return count === 1 ? t("mcp.check.connectedOne") : t("mcp.check.connectedMany", { count });
}

export function McpServersPanel({ embedded = false, whopCard = false, hideWhop = false, refreshKey = 0, onWhopConnection }: {
  embedded?: boolean;
  whopCard?: boolean;
  hideWhop?: boolean;
  refreshKey?: number;
  onWhopConnection?: (connected: boolean) => void;
} = {}) {
  const { state: store, dispatch } = useStore();
  const botName = (id: string) => store.bots?.find((bot) => bot.id === id)?.name ?? id;
  const policy = store.config?.managedPolicy;
  const restricted = Boolean(policy && !policy.mcp.allowCustom);
  const [servers, setServers] = useState<McpServerListing[] | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | McpMessage | null>(null);
  const [notice, setNotice] = useState<(McpMessage & { stateKey?: LocaleKey }) | null>(null);
  const [probe, setProbe] = useState<Record<string, ProbeResult>>({});
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const signInAbort = useRef<AbortController | null>(null);
  const signInComplete = useRef<((result: McpSignInStatus) => void) | null>(null);
  const [signInFlow, setSignInFlow] = useState<McpSignInStatus | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [completingSignIn, setCompletingSignIn] = useState(false);
  const [fixingKeys, setFixingKeys] = useState(false);
  /** Each server a passing test just switched on, and when; and the one being tested to switch it on. */
  const switchedOn = useRef<Record<string, number>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const mounted = useRef(true);
  const whopServer = servers?.find((server) => isRemoteMcpListing(server) && isWhopServer(server));
  const whopConnected = Boolean(whopServer?.enabled && isRemoteMcpListing(whopServer) && whopServer.auth === "signed-in");
  useEffect(() => { if (servers !== null) onWhopConnection?.(whopConnected); }, [servers, whopConnected, onWhopConnection]);

  const listed = (next: McpServerListing[] | undefined) => {
    setServers(next ?? []);
    updateMcpServers(next ?? []);
    return next ?? [];
  };
  const forgetProbe = (name: string) => setProbe((current) => {
    const next = { ...current };
    delete next[name];
    return next;
  });

  const load = useCallback(() => {
    const generation = ++loadGeneration.current;
    setBusy("load");
    setError(null);
    return api("/api/mcp/servers")
      .then((result) => {
        if (generation === loadGeneration.current) {
          setServers(result.servers ?? []);
          updateMcpServers(result.servers ?? []);
        }
      })
      .catch((cause) => {
        if (generation === loadGeneration.current) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (generation === loadGeneration.current) setBusy(null);
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; loadGeneration.current += 1; };
  }, [load, refreshKey]);

  const closeEditor = () => { setEditing(null); setFixingKeys(false); };
  const openEditor = (name: string | "new", keys = false) => {
    setEditing(name);
    setFixingKeys(keys);
    setError(null);
    setNotice(null);
  };

  /** Tests a server and turns it on when it answers; what it said stays on its row. `saved`: it was just saved. */
  const connect = async (name: string, saved = false): Promise<ProbeResult> => {
    setBusy(`test:${name}`);
    setConnecting(name);
    loadGeneration.current += 1;
    forgetProbe(name);
    let result: ProbeResult = await toolsCheck(name, api);
    if (result.ok) {
      try {
        listed((await api(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) })).servers);
        switchedOn.current[name] = Date.now();
      } catch (cause) {
        result = { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    }
    if (saved) result = { ...result, saved: true };
    if (mounted.current) {
      setProbe((current) => ({ ...current, [name]: result }));
      setBusy(null);
      setConnecting(null);
    }
    return result;
  };

  const addServers = async (items: McpServerSubmission[]) => {
    setBusy("save");
    loadGeneration.current += 1;
    setError(null);
    setNotice(null);
    const added: string[] = [];
    let latest = servers ?? [];
    try {
      for (const item of items) {
        const body = item.ownKey
          ? { ...item.body, headers: Object.fromEntries(Object.keys(item.body.headers ?? {}).map((name) => [name, ""])) }
          : item.body;
        latest = listed((await api("/api/mcp/servers", { method: "POST", body: JSON.stringify({ name: item.name, ...body }) })).servers);
        if (item.ownKey) {
          await api("/api/team/connection-scopes", { method: "PUT", body: JSON.stringify({ kind: "mcp", id: item.name, scope: "person" }) });
          await api(`/api/team/my-connections/mcp/${encodeURIComponent(item.name)}/key`, { method: "PUT", body: JSON.stringify({ value: item.ownKey, url: body.url }) });
          latest = listed((await api(`/api/mcp/servers/${encodeURIComponent(item.name)}`, {
            method: "PUT", body: JSON.stringify({ ...body, enabled: false }),
          })).servers);
        }
        added.push(item.name);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(null);
    if (added.length) closeEditor();
    for (const name of added) {
      const result = await connect(name, true);
      const server = latest.find((each) => each.name === name);
      if (result.auth === "required" && server && added.length === 1 && mounted.current) await signIn(server);
    }
  };

  const saveEdit = async ([item]: McpServerSubmission[]) => {
    const existing = servers?.find((server) => server.name === editing);
    if (!item || !existing) return;
    setBusy("save");
    loadGeneration.current += 1;
    setError(null);
    setNotice(null);
    try {
      let body = item.body;
      let ownKey: string | undefined;
      if (store.config?.team && existing.scope !== "team" && typeof body.url === "string" && !body.oauth) {
        const connections = await api("/api/team/my-connections");
        if (connections.mcp.some((connection: { name: string }) => connection.name === item.name)) {
          const headers = (body.headers ?? {}) as Record<string, string | true>;
          if (Object.keys(headers).length > 1) {
            throw new Error("Personal MCP connections support one header. Remove the extra headers before saving.");
          }
          const value = Object.values(headers)[0];
          ownKey = typeof value === "string" ? value : undefined;
          body = { ...body, headers: Object.fromEntries(Object.keys(headers).map((name) => [name, ""])) };
        }
      }
      listed((await api(`/api/mcp/servers/${encodeURIComponent(item.name)}`, { method: "PUT", body: JSON.stringify({ ...body, enabled: existing.enabled }) })).servers);
      if (ownKey) await api(`/api/team/my-connections/mcp/${encodeURIComponent(item.name)}/key`, { method: "PUT", body: JSON.stringify({ value: ownKey, url: body.url }) });
      closeEditor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
      return;
    }
    setBusy(null);
    if (!existing.runsOn) await connect(item.name, true);
  };

  const toggle = async (server: McpServerListing) => {
    if (server.enabled && Date.now() - (switchedOn.current[server.name] ?? 0) < SWITCH_SETTLE_MS) {
      setNotice({ key: "mcp.switchedOnByTest", params: { name: server.name } });
      return;
    }
    setBusy(`toggle:${server.name}`);
    loadGeneration.current += 1;
    setError(null);
    try {
      listed((await api(`/api/mcp/servers/${server.name}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !server.enabled }),
      })).servers);
      setNotice({
        key: "mcp.toggled",
        params: { name: server.name },
        stateKey: server.enabled ? "mcp.state.off" : "mcp.state.on",
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const test = async (server: McpServerListing) => {
    setBusy(`test:${server.name}`);
    loadGeneration.current += 1;
    setError(null);
    forgetProbe(server.name);
    const result = await toolsCheck(server.name, api);
    setProbe((current) => ({ ...current, [server.name]: result }));
    setBusy(null);
  };

  async function signIn(server: McpServerListing) {
    const controller = new AbortController();
    signInAbort.current = controller;
    setSigningIn(server.name);
    setSignInFlow(null);
    setCallbackUrl("");
    setCallbackError(null);
    setError(null);
    setNotice(null);
    forgetProbe(server.name);
    const whop = isRemoteMcpListing(server) && isWhopServer(server);
    try {
      const result = await runMcpSignIn(server.name, { api, open: openExternalLink, signal: controller.signal, onStarted: (status, complete) => {
        setSignInFlow(status);
        signInComplete.current = complete;
      } });
      if (!mounted.current || controller.signal.aborted) return;
      if (result.phase === "succeeded") {
        setSignInFlow({ ...result, flowId: null, authorizationUrl: null });
        const tested = whop ? await signedInToolsCheck(server.name, api, controller.signal) : await toolsCheck(server.name, api, controller.signal);
        if (controller.signal.aborted || !mounted.current) return;
        setProbe((current) => ({ ...current, [server.name]: tested }));
        if (!tested.ok) return;
        const enabled = await api(`/api/mcp/servers/${server.name}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
        if (!mounted.current) return;
        listed(enabled.servers);
        if (whop) setNotice({ key: "whop.connected" });
      } else if (result.phase !== "cancelled") {
        setProbe((current) => ({ ...current, [server.name]: { ok: false, error: result.message || t("mcp.auth.failed") } }));
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setProbe((current) => ({ ...current, [server.name]: { ok: false, error: cause instanceof Error ? cause.message : String(cause) } }));
    } finally {
      if (signInAbort.current === controller) {
        signInAbort.current = null;
        signInComplete.current = null;
        setCompletingSignIn(false);
        setSigningIn(null);
        setSignInFlow(null);
        setCallbackUrl("");
        setCallbackError(null);
        if (mounted.current) void load();
      }
    }
  }

  const connectWhop = async () => {
    if (!servers || busy !== null || signingIn !== null) return;
    const existing = servers.find((server) => isRemoteMcpListing(server) && isWhopServer(server));
    if (existing) { await signIn(existing); return; }
    setBusy("whop");
    loadGeneration.current += 1;
    setError(null);
    setNotice(null);
    let added: McpServerListing | undefined;
    try {
      const name = whopServerName(servers);
      const result = await api("/api/mcp/servers", { method: "POST", body: JSON.stringify({ name, type: "http", url: WHOP_MCP_URL, enabled: false }) });
      if (!mounted.current) return;
      added = listed(result.servers).find((server: McpServerListing) => server.name === name && isRemoteMcpListing(server) && isWhopServer(server));
      if (!added) throw new Error(t("whop.setupFailed"));
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (mounted.current) setBusy(null); }
    if (added && mounted.current) await signIn(added);
  };

  const completeSignIn = async () => {
    if (!signingIn || !signInFlow?.flowId || completingSignIn) return;
    const controller = signInAbort.current;
    setCompletingSignIn(true);
    setCallbackError(null);
    try {
      const result = await completeMcpSignIn(signingIn, signInFlow.flowId, callbackUrl, api);
      if (signInAbort.current === controller) signInComplete.current?.(result);
    } catch (cause) {
      if (signInAbort.current === controller) setCallbackError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (signInAbort.current === controller) setCompletingSignIn(false);
    }
  };

  const signOut = async (server: McpServerListing) => {
    setBusy(`signout:${server.name}`);
    loadGeneration.current += 1;
    setError(null);
    setNotice(null);
    forgetProbe(server.name);
    try {
      if (isRemoteMcpListing(server) && isWhopServer(server)) {
        listed((await api(`/api/mcp/servers/${server.name}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).servers);
      }
      listed((await api(`/api/mcp/servers/${server.name}/sign-out`, { method: "POST" })).servers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => () => signInAbort.current?.abort(), []);

  const remove = async (server: McpServerListing) => {
    if (!window.confirm(t("mcp.removeConfirm", { name: server.name }))) return;
    setBusy(`delete:${server.name}`);
    loadGeneration.current += 1;
    setError(null);
    try {
      listed((await api(`/api/mcp/servers/${server.name}`, { method: "DELETE" })).servers);
      forgetProbe(server.name);
      if (editing === server.name) closeEditor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const editingServer = editing && editing !== "new" ? servers?.find((server) => server.name === editing) : undefined;

  function renderPasteBack(server: McpServerListing) {
    return (
      <>
        <label className="mt-3 block" htmlFor={`mcp-callback-${server.name}`}>{t("mcp.auth.callbackUrl")}</label>
        <input id={`mcp-callback-${server.name}`} type="text" value={callbackUrl} disabled={completingSignIn} onChange={(event) => setCallbackUrl(event.target.value)}
          autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:…/mcp-oauth/callback?…"
          className="mt-1 w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-ink outline-none focus:border-accent" />
        <button type="button" disabled={!callbackUrl.trim() || completingSignIn} aria-busy={completingSignIn} onClick={() => void completeSignIn()}
          className="mt-2 inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-40">
          {completingSignIn && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {t(completingSignIn ? "mcp.auth.completing" : "mcp.auth.complete")}
        </button>
      </>
    );
  }

  function renderSignIn(server: McpServerListing) {
    return signingIn === server.name && (
      <div className="mt-3 space-y-3 rounded-lg bg-raised px-3 py-3 text-[12px] text-ink-secondary">
        <div role="status" className="flex items-center gap-2">
          <Loader2 size={13} className="animate-spin" /> {t(signInFlow?.phase !== "succeeded" ? "mcp.auth.waiting" : isRemoteMcpListing(server) && isWhopServer(server) ? "whop.loadingTools" : "mcp.auth.loadingTools")}
        </div>
        {signInFlow?.authorizationUrl && mcpSignInLink(signInFlow.authorizationUrl) && (
          <button type="button" onClick={() => void openExternalLink(signInFlow.authorizationUrl!).catch(() => setCallbackError(t("mcp.auth.openFailed")))} className="text-accent hover:underline">
            {t("mcp.auth.openAgain")}
          </button>
        )}
        {signInFlow?.flowId && (signInFlow.pasteBack
          ? <div>
              <p className="leading-relaxed text-ink">{t("mcp.auth.pasteBackHint")}</p>
              {renderPasteBack(server)}
            </div>
          : <details>
              <summary className="cursor-pointer font-medium text-ink">{t("mcp.auth.otherComputer")}</summary>
              <p className="mt-2 leading-relaxed">{t("mcp.auth.otherComputerHint")}</p>
              {renderPasteBack(server)}
            </details>)}
        {callbackError && <p role="alert" className="text-danger">{callbackError}</p>}
      </div>
    );
  }

  if (whopCard) {
    const result = whopServer && probe[whopServer.name];
    const failed = error || (result && !result.ok ? result.error : null);
    const pending = busy !== null || signingIn !== null;
    return <div data-app-tile="whop" className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40">
      <div className="flex items-center gap-3">
        <WhopIcon />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-ink">Whop</span>
            {whopConnected && <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />}
          </div>
          <p className="truncate text-[13px] leading-[18px] text-ink-secondary" title={t("whop.description")}>{t("whop.description")}</p>
        </div>
        {signingIn ? <button type="button" onClick={() => signInAbort.current?.abort()} className="inline-flex h-7 shrink-0 items-center rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink">{t("mcp.auth.cancel")}</button> :
          <button type="button" aria-label={t(whopConnected ? "whop.disconnect" : "whop.connect")}
            disabled={pending || (servers !== null && !whopConnected && (Boolean(whopServer?.managedBy) || (restricted && !policy?.mcp.allowlist.length)))}
            onClick={() => void (servers === null ? load() : whopConnected && whopServer ? signOut(whopServer) : connectWhop())}
            className="inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink hover:bg-raised-hover disabled:opacity-40">
            {pending ? <Loader2 size={14} className="animate-spin" /> : servers === null ? t("connectors.action.retry") : t(whopConnected ? "connectors.disconnect" : "connectors.action.connect")}
          </button>}
      </div>
      <div className="ps-[52px]">
      {failed && <p role="alert" className="mt-1.5 text-[12px] text-danger">{typeof failed === "string" ? failed : t(failed.key, failed.params)}</p>}
      {whopServer && renderSignIn(whopServer)}
      <details className="mt-1 text-[12px] text-ink-secondary">
        <summary className="cursor-pointer">{t("whop.access")}</summary>
        <p className="mt-2 leading-relaxed">{t("whop.notice")}</p>
        <p className="mt-2 leading-relaxed">{t("whop.accessHint")}</p>
        <div className="mt-2 flex flex-wrap gap-2">{(store.bots ?? []).filter((bot) => !bot.hidden).map((bot) => <button key={bot.id} type="button" onClick={() => { dispatch({ type: "togglePlugins", open: false }); openBotSettings(dispatch, "access", { botId: bot.id, page: "mcp" }); }} className="rounded-lg bg-control px-2.5 py-1.5 text-ink hover:bg-raised-hover">{t("whop.botSettings", { name: bot.name })}</button>)}</div>
      </details>
      </div>
    </div>;
  }

  const visibleServers = servers?.filter((server) => !hideWhop || !isRemoteMcpListing(server) || !(isWhopServer(server) || server.name === POSTIZ_SERVER));

  return (
    <section
      data-mcp-servers
      aria-labelledby="mcp-servers-title"
      className={embedded ? "" : "min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5 sm:px-8"}
    >
      <div className={embedded ? "" : "mx-auto max-w-[840px]"}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-[1_1_280px]">
            <h3 id="mcp-servers-title" className="text-[15px] font-semibold text-ink">{t("mcp.title")}</h3>
            <p className="mt-1 max-w-[610px] break-words text-[13px] leading-relaxed text-ink-secondary">
              {t("mcp.subtitle")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={busy !== null}
              className="rounded-lg p-2 text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
              aria-label={t("mcp.refreshAria")}
            >
              <RefreshCw size={16} className={cn(busy === "load" && "animate-spin")} />
            </button>
            <button
              type="button"
              disabled={busy !== null || (restricted && !policy?.mcp.allowlist.length)}
              title={restricted && policy ? t("policy.managedBy", { organization: policy.organizationName }) : undefined}
              onClick={() => openEditor("new")}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-40"
            >
              <Plus size={14} /> {t(embedded ? "apps.mcp.add" : "mcp.addServer")}
            </button>
          </div>
        </div>

        {restricted && policy && <p role="status" className="mt-3 text-[13px] leading-relaxed text-ink-secondary">{t("policy.mcpRestricted", { organization: policy.organizationName })}</p>}
        {(editing === "new" || editingServer) && (
          <McpServerEditor key={`${editing}${fixingKeys ? ":keys" : ""}`} server={editingServer} fixKeys={fixingKeys} taken={(servers ?? []).map((server) => server.name)} team={Boolean(store.config?.team)}
            busy={busy !== null} onCancel={closeEditor} onSubmit={(items) => void (editing === "new" ? addServers(items) : saveEdit(items))} />
        )}
        {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{typeof error === "string" ? error : t(error.key, error.params)}</div>}
        {notice && <div role="status" className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-[12px] text-success">{t(notice.key, {
          ...notice.params,
          ...(notice.stateKey ? { state: t(notice.stateKey) } : {}),
        })}</div>}
        <ClaudeCodeSwitches />

        <div className="mt-4 rounded-xl border border-hairline/50 bg-raised/35 px-4 py-3 text-[12px] leading-relaxed text-ink-secondary">
          {t("mcp.trustNotice")}
        </div>

        {servers === null ? (
          <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" /> {t("mcp.loading")}</div>
        ) : visibleServers?.length === 0 && !editing ? (
          <div className="mt-5 flex min-h-32 flex-col items-center justify-center rounded-2xl border border-dashed border-hairline/60 text-center">
            <div className="flex size-11 items-center justify-center rounded-xl bg-raised text-ink-secondary"><ServerCog size={21} /></div>
            <div className="mt-3 text-[14px] font-medium text-ink">{t("mcp.empty.title")}</div>
            <div className="mt-1 max-w-sm text-[13px] text-ink-secondary">{t("mcp.empty.desc")}</div>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {visibleServers?.map((server) => {
              const whop = isRemoteMcpListing(server) && isWhopServer(server);
              const result = probe[server.name];
              const auth = isRemoteMcpListing(server) ? server.auth : undefined;
              const canSignIn = isRemoteMcpListing(server) && !server.runsOn
                && (auth === "needs-sign-in" || result?.auth === "required" || ((whop || Boolean(server.oauth)) && auth !== "signed-in"));
              return (
                <div key={server.name} data-whop-server={whop ? server.name : undefined} className="rounded-2xl border border-hairline/50 bg-card px-4 py-4 sm:px-5">
                  <div data-mcp-row className="flex flex-wrap items-center gap-3">
                    <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", server.enabled ? "bg-success/10 text-success" : "bg-raised text-ink-secondary")}>
                      {whop ? <WhopIcon /> : isRemoteMcpListing(server) ? <Globe size={19} /> : <ServerCog size={19} />}
                    </div>
                    <div className="min-w-0 flex-[1_1_220px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 truncate text-[14px] font-medium text-ink">{whop ? "Whop" : server.name}</span>
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px]", server.enabled ? "bg-success/10 text-success" : "bg-raised text-ink-secondary")}>{t(server.enabled ? "mcp.badge.on" : "mcp.badge.off")}</span>
                        {auth && <span className={cn("rounded-full px-2 py-0.5 text-[11px]", auth === "signed-in" ? "bg-success/10 text-success" : "bg-warning/10 text-warning")}>{t(auth === "signed-in" ? "mcp.auth.signedIn" : "mcp.auth.needsSignIn")}</span>}
                        {server.managedBy && <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-ink-secondary">{t("policy.managedBy", { organization: server.managedBy })}</span>}
                      </div>
                      {server.managedBy && <div className="mt-1 text-[12px] text-ink-secondary">{t("policy.mcpBlocked", { organization: server.managedBy })}</div>}
                      {server.runsOn && <div data-mcp-runs-on className="mt-1 text-[12px] text-ink-secondary">{t("mcp.runsOn", { computer: server.runsOn.label })}</div>}
                      {server.bot && <div data-mcp-own-bot className="mt-1 text-[12px] text-ink-secondary">{t("mcp.ownBot", { bot: botName(server.bot) })}</div>}
                      {server.offFor?.length ? <div data-mcp-off-for className="mt-1 text-[12px] text-ink-secondary">{t("mcp.offFor", { bots: server.offFor.map(botName).join(", ") })}</div> : null}
                      <div className="mt-1 truncate font-mono text-[12px] text-ink-secondary">{isRemoteMcpListing(server) ? server.url : [server.command, ...server.args].join(" ")}</div>
                      {isRemoteMcpListing(server)
                        ? server.headerKeys.length > 0 && <div className="mt-1 truncate text-[11px] text-ink-secondary">{t("mcp.headersSaved", { keys: server.headerKeys.join(", ") })}</div>
                        : server.envKeys.length > 0 && <div className="mt-1 truncate text-[11px] text-ink-secondary">{t("mcp.secretsSaved", { keys: server.envKeys.join(", ") })}</div>}
                      {isRemoteMcpListing(server) && server.oauth && <div className="mt-1 truncate text-[11px] text-ink-secondary">{t(server.oauth.clientSecretConfigured ? "mcp.oauth.savedWithSecret" : "mcp.oauth.saved", { clientId: server.oauth.clientId })}</div>}
                    </div>
                    <div data-mcp-row-actions className="ml-auto flex flex-wrap items-center justify-end gap-1">
                      {signingIn === server.name ? (
                        <button type="button" onClick={() => signInAbort.current?.abort()} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink">
                          <Loader2 size={14} className="animate-spin" /> {t("mcp.auth.cancel")}
                        </button>
                      ) : canSignIn ? (
                        <button type="button" disabled={busy !== null || signingIn !== null || Boolean(server.managedBy)} onClick={() => void signIn(server)} className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-2 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40">
                          <LogIn size={14} /> {t(whop ? "whop.connect" : "mcp.auth.signIn")}
                        </button>
                      ) : auth === "signed-in" ? (
                        <button type="button" disabled={busy !== null || signingIn !== null} onClick={() => void signOut(server)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">
                          {busy === `signout:${server.name}` ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />} {t(whop ? "whop.disconnect" : "mcp.auth.signOut")}
                        </button>
                      ) : null}
                      <button type="button" disabled={busy !== null || signingIn !== null} onClick={() => void test(server)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">
                        {busy === `test:${server.name}` ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />} {t("mcp.test")}
                      </button>
                      <button type="button" disabled={busy !== null || signingIn !== null} onClick={() => openEditor(server.name)} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40" aria-label={t("mcp.editAria", { name: server.name })}><Pencil size={14} /></button>
                      <button type="button" disabled={busy !== null || signingIn !== null} onClick={() => void remove(server)} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40" aria-label={t("mcp.removeAria", { name: server.name })}><Trash2 size={14} /></button>
                      <span className="ml-1 flex items-center">
                        {busy === `toggle:${server.name}` && <Loader2 size={13} className="mr-1.5 animate-spin text-ink-secondary" />}
                        <Switch
                          checked={server.enabled}
                          disabled={busy !== null || signingIn !== null}
                          onClick={() => void toggle(server)}
                          aria-label={t("mcp.toggleAria", {
                            name: server.name,
                            state: t(server.enabled ? "mcp.state.off" : "mcp.state.on"),
                          })}
                          className="disabled:opacity-40"
                        />
                      </span>
                    </div>
                  </div>
                  {whop && <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
                    <p>{t("whop.notice")}</p>
                    <details className="mt-2">
                      <summary className="cursor-pointer font-medium text-ink">{t("whop.access")}</summary>
                      <p className="mt-2">{t("whop.accessHint")}</p>
                      <div className="mt-2 flex flex-wrap gap-2">{(store.bots ?? []).filter((bot) => !bot.hidden).map((bot) => <button key={bot.id} type="button" onClick={() => { dispatch({ type: "togglePlugins", open: false }); openBotSettings(dispatch, "access", { botId: bot.id, page: "mcp" }); }} className="rounded-lg bg-control px-2.5 py-1.5 text-ink hover:bg-raised-hover">{t("whop.botSettings", { name: bot.name })}</button>)}</div>
                    </details>
                  </div>}
                  <McpAppsSwitch<McpServerListing> server={server} disabled={busy !== null || signingIn !== null} onSaved={(next) => { loadGeneration.current += 1; listed(next); }} />{renderSignIn(server)}
                  {connecting === server.name && !server.enabled && !result && (
                    <div role="status" data-mcp-testing className="mt-3 flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-[12px] text-ink-secondary">
                      <Loader2 size={13} className="animate-spin" aria-hidden="true" /> {t("mcp.check.testingOff")}
                    </div>
                  )}
                  {result && signingIn !== server.name && (
                    <div role="status" className={cn("mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-[12px]", result.ok ? "bg-success/10 text-success" : result.auth === "required" ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger")}>
                      {result.auth === "required" ? t("mcp.auth.required") : result.ok ? (
                        <span className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-px shrink-0" /> {connectedLabel(result)}</span>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1">{t(server.enabled ? "mcp.check.failed" : result.saved ? "mcp.check.savedOff" : "mcp.check.failedOff", { reason: failureReason(server, result) })}</span>
                          {(result.reason === "keys" && isRemoteMcpListing(server)) || result.reason === "unreachable" || result.reason === "timeout" ? (
                            <button type="button" disabled={busy !== null || signingIn !== null}
                              onClick={() => result.reason === "keys" ? openEditor(server.name, true) : void connect(server.name)}
                              className="shrink-0 rounded-lg bg-card px-2.5 py-1.5 font-medium text-ink hover:bg-raised-hover disabled:opacity-40">
                              {t(result.reason === "keys" ? "mcp.check.fixKeys" : "mcp.check.tryAgain")}
                            </button>
                          ) : null}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
