import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CirclePower,
  ClipboardPaste,
  FlaskConical,
  Globe,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { claudeUserMcpEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { updateMcpServers } from "@/lib/mcp-servers";
import { api, useStore, type ConfigStatus } from "@/state/store";

import { Switch } from "./SettingsPrimitives";

/** A server this computer starts (a command) or one reached at a URL —
 * the two shapes the server stores. Secrets arrive as names only. */
interface StdioMcpListing {
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  enabled: boolean;
}
interface RemoteMcpListing {
  name: string;
  type: "http" | "sse";
  url: string;
  headerKeys: string[];
  enabled: boolean;
}
/** managedBy: the enrolled organisation has not approved this server, so it
 * stays configured but never reaches bots. */
export type McpServerListing = (StdioMcpListing | RemoteMcpListing) & { managedBy?: string };

export function isRemoteMcpListing(server: McpServerListing): server is RemoteMcpListing {
  return "url" in server;
}

type McpTransport = "stdio" | "remote";

interface McpDraft {
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  env: string;
  type: "http" | "sse";
  url: string;
  headers: string;
}

interface ProbeResult {
  ok: boolean;
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
}

interface McpMessage {
  key: LocaleKey;
  params?: Record<string, string | number>;
}

const EMPTY_DRAFT: McpDraft = { name: "", transport: "stdio", command: "", args: "", env: "", type: "http", url: "", headers: "" };
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

export function parseMcpArguments(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function parseMcpEnvironment(
  value: string,
  savedKeys: readonly string[] = [],
): { ok: true; env: Record<string, string | true> } | { ok: false; error: McpMessage } {
  const saved = new Set(savedKeys);
  const env: Record<string, string | true> = {};
  for (const original of value.split(/\r?\n/)) {
    const line = original.trim();
    if (!line) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) return { ok: false, error: { key: "mcp.env.useKeyValue", params: { line } } };
    const key = line.slice(0, equals).trim();
    const secret = line.slice(equals + 1);
    if (!ENV_NAME.test(key)) return { ok: false, error: { key: "mcp.env.invalidName", params: { key } } };
    if (Object.hasOwn(env, key)) return { ok: false, error: { key: "mcp.env.duplicate", params: { key } } };
    env[key] = secret === "" && saved.has(key) ? true : secret;
  }
  return { ok: true, env };
}

/** `Name: value` per line, the way headers are written everywhere. A blank
 * value beside a saved header keeps the saved value, as with env above. */
export function parseMcpHeaders(
  value: string,
  savedKeys: readonly string[] = [],
): { ok: true; headers: Record<string, string | true> } | { ok: false; error: McpMessage } {
  const saved = new Set(savedKeys);
  const headers: Record<string, string | true> = {};
  for (const original of value.split(/\r?\n/)) {
    const line = original.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return { ok: false, error: { key: "mcp.headers.useColon", params: { line } } };
    const key = line.slice(0, colon).trim();
    const secret = line.slice(colon + 1).trim();
    if (!HEADER_NAME.test(key)) return { ok: false, error: { key: "mcp.headers.invalidName", params: { key } } };
    if (Object.hasOwn(headers, key)) return { ok: false, error: { key: "mcp.headers.duplicate", params: { key } } };
    headers[key] = secret === "" && saved.has(key) ? true : secret;
  }
  return { ok: true, headers };
}

function probeToolsLabel(tools: ProbeResult["tools"]): string {
  if (!tools?.length) return t("mcp.probe.noTools");
  const names = tools.map((tool) => tool.name).join(", ");
  return tools.length === 1
    ? t("mcp.probe.toolsOne", { names })
    : t("mcp.probe.toolsMany", { count: tools.length, names });
}

function draftFor(server: McpServerListing): McpDraft {
  // Values are intentionally never returned by the server. A blank value
  // beside an existing key is a write-only “keep saved value” placeholder.
  if (isRemoteMcpListing(server)) {
    return {
      ...EMPTY_DRAFT,
      name: server.name,
      transport: "remote",
      type: server.type,
      url: server.url,
      headers: server.headerKeys.map((key) => `${key}: `).join("\n"),
    };
  }
  return {
    ...EMPTY_DRAFT,
    name: server.name,
    command: server.command,
    args: server.args.join("\n"),
    env: server.envKeys.map((key) => `${key}=`).join("\n"),
  };
}

export function McpServersPanel() {
  const { state: store } = useStore();
  // While enrolled with custom servers off, only approved servers can be added.
  const policy = store.config?.managedPolicy;
  const restricted = Boolean(policy && !policy.mcp.allowCustom);
  const [servers, setServers] = useState<McpServerListing[] | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<McpDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | McpMessage | null>(null);
  const [notice, setNotice] = useState<(McpMessage & { stateKey?: LocaleKey }) | null>(null);
  const [probe, setProbe] = useState<Record<string, ProbeResult>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const loadGeneration = useRef(0);

  // Paste-to-add: the same block Claude Code, Cursor and Claude Desktop
  // write. The server applies the form's rules and adds them switched off.
  const importServers = async () => {
    if (!importText.trim()) return;
    const generation = ++loadGeneration.current;
    setBusy("import");
    setError(null);
    setNotice(null);
    try {
      const result = await api("/api/mcp/servers/import", {
        method: "POST",
        body: JSON.stringify({ json: importText }),
      });
      updateMcpServers(result.servers ?? []);
      if (generation !== loadGeneration.current) return;
      setServers(result.servers ?? []);
      setNotice({ key: "mcp.imported", params: { names: (result.added ?? []).join(", ") } });
      setImportText("");
      setImportOpen(false);
    } catch (cause) {
      if (generation === loadGeneration.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === loadGeneration.current) setBusy(null);
    }
  };

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
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  const closeEditor = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  };

  /** The request body for the draft, or the message that stops it. */
  const draftBody = (
    existing: McpServerListing | undefined,
  ): { ok: true; body: Record<string, unknown> } | { ok: false; error: McpMessage } => {
    const name = draft.name.trim();
    if (draft.transport === "remote") {
      const url = draft.url.trim();
      if (!name || !/^https?:\/\//i.test(url)) return { ok: false, error: { key: "mcp.err.nameAndUrl" } };
      const parsed = parseMcpHeaders(draft.headers, existing && isRemoteMcpListing(existing) ? existing.headerKeys : []);
      if (!parsed.ok) return parsed;
      return { ok: true, body: { type: draft.type, url, headers: parsed.headers } };
    }
    const command = draft.command.trim();
    if (!name || !command) return { ok: false, error: { key: "mcp.err.nameAndCommand" } };
    const parsed = parseMcpEnvironment(draft.env, existing && !isRemoteMcpListing(existing) ? existing.envKeys : []);
    if (!parsed.ok) return parsed;
    return { ok: true, body: { command, args: parseMcpArguments(draft.args), env: parsed.env } };
  };

  const save = async () => {
    const name = draft.name.trim();
    const existing = editing === "new" ? undefined : servers?.find((server) => server.name === editing);
    const prepared = draftBody(existing);
    if (!prepared.ok) {
      setError(prepared.error);
      return;
    }
    setBusy("save");
    loadGeneration.current += 1;
    setError(null);
    setNotice(null);
    try {
      const result = await api(
        editing === "new" ? "/api/mcp/servers" : `/api/mcp/servers/${encodeURIComponent(name)}`,
        {
          method: editing === "new" ? "POST" : "PUT",
          body: JSON.stringify({
            ...(editing === "new" ? { name } : {}),
            ...prepared.body,
            ...(existing ? { enabled: existing.enabled } : {}),
          }),
        },
      );
      setServers(result.servers ?? []);
      updateMcpServers(result.servers ?? []);
      setNotice({ key: editing === "new" ? "mcp.saved" : "mcp.updated", params: { name } });
      closeEditor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (server: McpServerListing) => {
    setBusy(`toggle:${server.name}`);
    loadGeneration.current += 1;
    setError(null);
    try {
      const result = await api(`/api/mcp/servers/${server.name}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !server.enabled }),
      });
      setServers(result.servers ?? []);
      updateMcpServers(result.servers ?? []);
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
    setProbe((current) => {
      const next = { ...current };
      delete next[server.name];
      return next;
    });
    try {
      const result: ProbeResult = await api(`/api/mcp/servers/${server.name}/test`, { method: "POST" });
      setProbe((current) => ({ ...current, [server.name]: result }));
    } catch (cause) {
      setProbe((current) => ({
        ...current,
        [server.name]: { ok: false, error: cause instanceof Error ? cause.message : String(cause) },
      }));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (server: McpServerListing) => {
    if (!window.confirm(t("mcp.removeConfirm", { name: server.name }))) return;
    setBusy(`delete:${server.name}`);
    loadGeneration.current += 1;
    setError(null);
    try {
      const result = await api(`/api/mcp/servers/${server.name}`, { method: "DELETE" });
      setServers(result.servers ?? []);
      updateMcpServers(result.servers ?? []);
      setProbe((current) => {
        const next = { ...current };
        delete next[server.name];
        return next;
      });
      if (editing === server.name) closeEditor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5 sm:px-8">
      <div className="mx-auto max-w-[840px]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-[15px] font-semibold text-ink">{t("mcp.title")}</h3>
            <p className="mt-1 max-w-[610px] text-[12.5px] leading-relaxed text-ink-secondary">
              {t("mcp.subtitle")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
              disabled={busy !== null || restricted}
              title={restricted && policy ? t("policy.managedBy", { organization: policy.organizationName }) : undefined}
              onClick={() => {
                setImportOpen((open) => !open);
                setError(null);
                setNotice(null);
              }}
              className="flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[12.5px] font-medium text-ink hover:bg-raised-hover disabled:opacity-40"
            >
              <ClipboardPaste size={14} /> {t("mcp.import")}
            </button>
            <button
              type="button"
              disabled={busy !== null || (restricted && !policy?.mcp.allowlist.length)}
              title={restricted && policy ? t("policy.managedBy", { organization: policy.organizationName }) : undefined}
              onClick={() => {
                setEditing("new");
                setDraft(EMPTY_DRAFT);
                setError(null);
                setNotice(null);
              }}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-white disabled:opacity-40"
            >
              <Plus size={14} /> {t("mcp.addServer")}
            </button>
          </div>
        </div>

        {restricted && policy && <p role="status" className="mt-3 text-[12.5px] leading-relaxed text-ink-secondary">{t("policy.mcpRestricted", { organization: policy.organizationName })}</p>}
        <ClaudeMcpSwitch />

        {importOpen && (
          <div className="mt-4 rounded-2xl border border-hairline/60 bg-card p-4 sm:p-5">
            <div className="text-[14px] font-medium text-ink">{t("mcp.import")}</div>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("mcp.importHint")}</p>
            <textarea
              autoFocus
              aria-label={t("mcp.import")}
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              spellCheck={false}
              rows={8}
              placeholder={'{\n  "mcpServers": {\n    "notes": { "command": "npx", "args": ["-y", "@example/notes-mcp"], "env": { "NOTES_TOKEN": "…" } },\n    "docs": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer …" } }\n  }\n}'}
              className="mt-3 w-full resize-y rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-accent"
            />
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={busy === "import"}
                onClick={() => {
                  setImportOpen(false);
                  setImportText("");
                }}
                className="rounded-lg px-3 py-2 text-[12.5px] text-ink-secondary hover:text-ink"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={busy !== null || !importText.trim()}
                onClick={() => void importServers()}
                className="rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-accent-ink disabled:opacity-40"
              >
                {t("mcp.importAction")}
              </button>
            </div>
          </div>
        )}

        <div className="mt-4 rounded-xl border border-hairline/50 bg-raised/35 px-4 py-3 text-[12px] leading-relaxed text-ink-secondary">
          {t("mcp.trustNotice")}
        </div>

        {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{typeof error === "string" ? error : t(error.key, error.params)}</div>}
        {notice && <div role="status" className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-[12px] text-success">{t(notice.key, {
          ...notice.params,
          ...(notice.stateKey ? { state: t(notice.stateKey) } : {}),
        })}</div>}

        {editing && (
          <div className="mt-4 rounded-2xl border border-hairline/60 bg-card p-4 sm:p-5">
            <div className="text-[14px] font-medium text-ink">{editing === "new" ? t("mcp.editorNew") : t("mcp.editorEdit", { name: editing })}</div>
            {editing === "new" && (
              <div className="mt-3 inline-flex rounded-lg bg-raised p-0.5" role="radiogroup" aria-label={t("mcp.field.type")}>
                {(["stdio", "remote"] as const).map((transport) => (
                  <button
                    key={transport}
                    type="button"
                    role="radio"
                    aria-checked={draft.transport === transport}
                    onClick={() => setDraft((current) => ({ ...current, transport }))}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
                      draft.transport === transport ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                    )}
                  >
                    {t(transport === "stdio" ? "mcp.transport.stdio" : "mcp.transport.remote")}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-[12px] font-medium text-ink-secondary">{t("mcp.field.name")}</span>
                <input
                  autoFocus={editing === "new"}
                  disabled={editing !== "new"}
                  value={draft.name}
                  maxLength={32}
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value.toLowerCase() }))}
                  placeholder="github"
                  className="mt-1.5 w-full rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-60"
                />
              </label>
              {draft.transport === "remote" ? (
                <>
                  <label className="block">
                    <span className="text-[12px] font-medium text-ink-secondary">{t("mcp.field.url")}</span>
                    <input
                      autoFocus={editing !== "new"}
                      value={draft.url}
                      onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
                      placeholder="https://mcp.example.com/mcp"
                      className="mt-1.5 w-full rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[12px] font-medium text-ink-secondary">{t("mcp.field.type")}</span>
                    <select
                      value={draft.type}
                      onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value === "sse" ? "sse" : "http" }))}
                      className="mt-1.5 w-full rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent"
                    >
                      <option value="http">{t("mcp.type.http")}</option>
                      <option value="sse">{t("mcp.type.sse")}</option>
                    </select>
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="text-[12px] font-medium text-ink-secondary">{t("mcp.field.headers")}</span>
                    <textarea
                      value={draft.headers}
                      onChange={(event) => setDraft((current) => ({ ...current, headers: event.target.value }))}
                      placeholder="Authorization: Bearer …"
                      rows={4}
                      className="mt-1.5 w-full resize-y rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
                    />
                    <span className="mt-1.5 block text-[11px] text-ink-secondary">{t("mcp.headersHint")}</span>
                  </label>
                </>
              ) : (
                <>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-secondary">{t("mcp.field.command")}</span>
                <input
                  autoFocus={editing !== "new"}
                  value={draft.command}
                  onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
                  placeholder="npx"
                  className="mt-1.5 w-full rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-secondary">{t("mcp.field.args")}</span>
                <textarea
                  value={draft.args}
                  onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))}
                  placeholder={"-y\n@modelcontextprotocol/server-github"}
                  rows={5}
                  className="mt-1.5 w-full resize-y rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-secondary">{t("mcp.field.env")}</span>
                <textarea
                  value={draft.env}
                  onChange={(event) => setDraft((current) => ({ ...current, env: event.target.value }))}
                  placeholder="GITHUB_TOKEN=…"
                  rows={5}
                  className="mt-1.5 w-full resize-y rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
                />
                {editing !== "new" && <span className="mt-1.5 block text-[11px] text-ink-secondary">{t("mcp.envHint")}</span>}
              </label>
                </>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={closeEditor} className="rounded-lg px-3 py-2 text-[12.5px] text-ink-secondary hover:bg-raised">{t("mcp.cancel")}</button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void save()}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-medium text-white disabled:opacity-50"
              >
                {busy === "save" && <Loader2 size={13} className="animate-spin" />} {t("mcp.save")}
              </button>
            </div>
          </div>
        )}

        {servers === null ? (
          <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" /> {t("mcp.loading")}</div>
        ) : servers.length === 0 && !editing ? (
          <div className="mt-5 flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-hairline/60 text-center">
            <div className="flex size-11 items-center justify-center rounded-xl bg-raised text-ink-secondary"><ServerCog size={21} /></div>
            <div className="mt-3 text-[14px] font-medium text-ink">{t("mcp.empty.title")}</div>
            <div className="mt-1 max-w-sm text-[12.5px] text-ink-secondary">{t("mcp.empty.desc")}</div>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {servers.map((server) => {
              const result = probe[server.name];
              return (
                <div key={server.name} className="rounded-2xl border border-hairline/50 bg-card px-4 py-4 sm:px-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", server.enabled ? "bg-success/10 text-success" : "bg-raised text-ink-secondary")}>
                      {isRemoteMcpListing(server) ? <Globe size={19} /> : <ServerCog size={19} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] font-medium text-ink">{server.name}</span>
                        <span className={cn("rounded-full px-2 py-0.5 text-[10.5px]", server.enabled ? "bg-success/10 text-success" : "bg-raised text-ink-secondary")}>{t(server.enabled ? "mcp.badge.on" : "mcp.badge.off")}</span>
                        {server.managedBy && <span className="rounded-full bg-raised px-2 py-0.5 text-[10.5px] text-ink-secondary">{t("policy.managedBy", { organization: server.managedBy })}</span>}
                      </div>
                      {server.managedBy && <div className="mt-1 text-[11.5px] text-ink-secondary">{t("policy.mcpBlocked", { organization: server.managedBy })}</div>}
                      <div className="mt-1 truncate font-mono text-[11.5px] text-ink-secondary">{isRemoteMcpListing(server) ? server.url : [server.command, ...server.args].join(" ")}</div>
                      {isRemoteMcpListing(server)
                        ? server.headerKeys.length > 0 && <div className="mt-1 truncate text-[11px] text-ink-secondary">{t("mcp.headersSaved", { keys: server.headerKeys.join(", ") })}</div>
                        : server.envKeys.length > 0 && <div className="mt-1 truncate text-[11px] text-ink-secondary">{t("mcp.secretsSaved", { keys: server.envKeys.join(", ") })}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button type="button" disabled={busy !== null} onClick={() => void test(server)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">
                        {busy === `test:${server.name}` ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />} {t("mcp.test")}
                      </button>
                      <button type="button" disabled={busy !== null} onClick={() => void toggle(server)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40" aria-label={t("mcp.toggleAria", {
                        name: server.name,
                        state: t(server.enabled ? "mcp.state.off" : "mcp.state.on"),
                      })}>
                        {busy === `toggle:${server.name}` ? <Loader2 size={14} className="animate-spin" /> : <CirclePower size={14} />} {t(server.enabled ? "mcp.turnOff" : "mcp.turnOn")}
                      </button>
                      <button type="button" disabled={busy !== null} onClick={() => { setEditing(server.name); setDraft(draftFor(server)); setError(null); setNotice(null); }} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40" aria-label={t("mcp.editAria", { name: server.name })}><Pencil size={14} /></button>
                      <button type="button" disabled={busy !== null} onClick={() => void remove(server)} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40" aria-label={t("mcp.removeAria", { name: server.name })}><Trash2 size={14} /></button>
                    </div>
                  </div>
                  {result && (
                    <div role="status" className={cn("mt-3 rounded-lg px-3 py-2 text-[12px]", result.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
                      {result.ok ? (
                        <span className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-px shrink-0" /> {t("mcp.probe.connected")} {probeToolsLabel(result.tools)}</span>
                      ) : result.error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** The one Claude-only setting on this page, in the words a person would
 * use. Claude bots normally see just the servers listed here; this switch
 * also gives them the MCP servers and connectors of this machine's own
 * Claude Code setup — what Codex bots already do with their config. Saved
 * on the workspace; the next message picks it up. */
function ClaudeMcpSwitch() {
  const { state, dispatch } = useStore();
  const enabled = claudeUserMcpEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { claudeUserMcp: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 flex items-start justify-between gap-4 rounded-2xl border border-hairline/50 bg-card px-4 py-4 sm:px-5">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-ink">{t("mcp.claude.title")}</div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("mcp.claude.desc")}</p>
        {failed && <p role="alert" className="mt-1 text-[12px] text-danger">{t("mcp.claude.error")}</p>}
      </div>
      <Switch
        checked={enabled}
        aria-label={t("mcp.claude.aria")}
        disabled={saving}
        onClick={() => void toggle()}
        className="mt-0.5 shrink-0 disabled:cursor-wait disabled:opacity-50"
      />
    </div>
  );
}
