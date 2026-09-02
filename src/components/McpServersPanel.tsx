import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CirclePower,
  FlaskConical,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { api } from "@/state/store";

export interface McpServerListing {
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  enabled: boolean;
}

interface McpDraft {
  name: string;
  command: string;
  args: string;
  env: string;
}

interface ProbeResult {
  ok: boolean;
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
}

const EMPTY_DRAFT: McpDraft = { name: "", command: "", args: "", env: "" };
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseMcpArguments(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function parseMcpEnvironment(
  value: string,
  savedKeys: readonly string[] = [],
): { ok: true; env: Record<string, string | true> } | { ok: false; error: string } {
  const saved = new Set(savedKeys);
  const env: Record<string, string | true> = {};
  for (const original of value.split(/\r?\n/)) {
    const line = original.trim();
    if (!line) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) return { ok: false, error: `Use KEY=value for “${line}”.` };
    const key = line.slice(0, equals).trim();
    const secret = line.slice(equals + 1);
    if (!ENV_NAME.test(key)) return { ok: false, error: `“${key}” is not a valid environment variable.` };
    if (Object.hasOwn(env, key)) return { ok: false, error: `“${key}” is listed more than once.` };
    env[key] = secret === "" && saved.has(key) ? true : secret;
  }
  return { ok: true, env };
}

function draftFor(server: McpServerListing): McpDraft {
  return {
    name: server.name,
    command: server.command,
    args: server.args.join("\n"),
    // Values are intentionally never returned by the server. A blank value
    // beside an existing key is a write-only “keep saved value” placeholder.
    env: server.envKeys.map((key) => `${key}=`).join("\n"),
  };
}

export function McpServersPanel() {
  const [servers, setServers] = useState<McpServerListing[] | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<McpDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [probe, setProbe] = useState<Record<string, ProbeResult>>({});
  const loadGeneration = useRef(0);

  const load = useCallback(() => {
    const generation = ++loadGeneration.current;
    setBusy("load");
    setError(null);
    return api("/api/mcp/servers")
      .then((result) => {
        if (generation === loadGeneration.current) setServers(result.servers ?? []);
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
  }, [load]);

  const closeEditor = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  };

  const save = async () => {
    const name = draft.name.trim();
    const command = draft.command.trim();
    if (!name || !command) {
      setError("Add a server name and executable command.");
      return;
    }
    const existing = editing === "new" ? undefined : servers?.find((server) => server.name === editing);
    const parsedEnv = parseMcpEnvironment(draft.env, existing?.envKeys);
    if (!parsedEnv.ok) {
      setError(parsedEnv.error);
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
            command,
            args: parseMcpArguments(draft.args),
            env: parsedEnv.env,
            ...(existing ? { enabled: existing.enabled } : {}),
          }),
        },
      );
      setServers(result.servers ?? []);
      setNotice(editing === "new"
        ? `${name} was saved off. Test it, then turn it on when you are ready.`
        : `${name} was updated.`);
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
      setNotice(`${server.name} is now ${server.enabled ? "off" : "on"}. New tasks will use this change.`);
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
    if (!window.confirm(`Remove the “${server.name}” MCP server?`)) return;
    setBusy(`delete:${server.name}`);
    loadGeneration.current += 1;
    setError(null);
    try {
      const result = await api(`/api/mcp/servers/${server.name}`, { method: "DELETE" });
      setServers(result.servers ?? []);
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
            <h3 className="text-[15px] font-semibold text-ink">Your MCP servers</h3>
            <p className="mt-1 max-w-[610px] text-[12.5px] leading-relaxed text-ink-secondary">
              Add a local stdio MCP command once and every compatible bot can use its tools. Tool calls still follow your normal approval settings.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={busy !== null}
              className="rounded-lg p-2 text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
              aria-label="Refresh MCP servers"
            >
              <RefreshCw size={16} className={cn(busy === "load" && "animate-spin")} />
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setEditing("new");
                setDraft(EMPTY_DRAFT);
                setError(null);
                setNotice(null);
              }}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-white disabled:opacity-40"
            >
              <Plus size={14} /> Add server
            </button>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-hairline/50 bg-raised/35 px-4 py-3 text-[12px] leading-relaxed text-ink-secondary">
          MCP commands run on this computer with the environment variables you provide. Only add software you trust. New servers stay off until you enable them.
        </div>

        {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
        {notice && <div role="status" className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-[12px] text-success">{notice}</div>}

        {editing && (
          <div className="mt-4 rounded-2xl border border-hairline/60 bg-card p-4 sm:p-5">
            <div className="text-[14px] font-medium text-ink">{editing === "new" ? "Add MCP server" : `Edit ${editing}`}</div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-[12px] font-medium text-ink-secondary">Server name</span>
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
              <label className="block">
                <span className="text-[12px] font-medium text-ink-secondary">Executable command</span>
                <input
                  autoFocus={editing !== "new"}
                  value={draft.command}
                  onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
                  placeholder="npx"
                  className="mt-1.5 w-full rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-secondary">Arguments · one per line</span>
                <textarea
                  value={draft.args}
                  onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))}
                  placeholder={"-y\n@modelcontextprotocol/server-github"}
                  rows={5}
                  className="mt-1.5 w-full resize-y rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-secondary">Environment · KEY=value per line</span>
                <textarea
                  value={draft.env}
                  onChange={(event) => setDraft((current) => ({ ...current, env: event.target.value }))}
                  placeholder="GITHUB_TOKEN=…"
                  rows={5}
                  className="mt-1.5 w-full resize-y rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
                />
                {editing !== "new" && <span className="mt-1.5 block text-[11px] text-ink-secondary">Leave an existing value blank to keep it saved. Remove the line to delete it.</span>}
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={closeEditor} className="rounded-lg px-3 py-2 text-[12.5px] text-ink-secondary hover:bg-raised">Cancel</button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void save()}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-medium text-white disabled:opacity-50"
              >
                {busy === "save" && <Loader2 size={13} className="animate-spin" />} Save
              </button>
            </div>
          </div>
        )}

        {servers === null ? (
          <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" /> Loading MCP servers…</div>
        ) : servers.length === 0 && !editing ? (
          <div className="mt-5 flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-hairline/60 text-center">
            <div className="flex size-11 items-center justify-center rounded-xl bg-raised text-ink-secondary"><ServerCog size={21} /></div>
            <div className="mt-3 text-[14px] font-medium text-ink">No custom MCP servers yet</div>
            <div className="mt-1 max-w-sm text-[12.5px] text-ink-secondary">Add a trusted stdio MCP server to give your bots more tools.</div>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {servers.map((server) => {
              const result = probe[server.name];
              return (
                <div key={server.name} className="rounded-2xl border border-hairline/50 bg-card px-4 py-4 sm:px-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", server.enabled ? "bg-success/10 text-success" : "bg-raised text-ink-secondary")}>
                      <ServerCog size={19} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] font-medium text-ink">{server.name}</span>
                        <span className={cn("rounded-full px-2 py-0.5 text-[10.5px]", server.enabled ? "bg-success/10 text-success" : "bg-raised text-ink-secondary")}>{server.enabled ? "On" : "Off"}</span>
                      </div>
                      <div className="mt-1 truncate font-mono text-[11.5px] text-ink-secondary">{[server.command, ...server.args].join(" ")}</div>
                      {server.envKeys.length > 0 && <div className="mt-1 truncate text-[11px] text-ink-secondary">Secrets saved: {server.envKeys.join(", ")}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button type="button" disabled={busy !== null} onClick={() => void test(server)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">
                        {busy === `test:${server.name}` ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />} Test
                      </button>
                      <button type="button" disabled={busy !== null} onClick={() => void toggle(server)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40" aria-label={`Turn ${server.name} ${server.enabled ? "off" : "on"}`}>
                        {busy === `toggle:${server.name}` ? <Loader2 size={14} className="animate-spin" /> : <CirclePower size={14} />} {server.enabled ? "Turn off" : "Turn on"}
                      </button>
                      <button type="button" disabled={busy !== null} onClick={() => { setEditing(server.name); setDraft(draftFor(server)); setError(null); setNotice(null); }} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40" aria-label={`Edit ${server.name}`}><Pencil size={14} /></button>
                      <button type="button" disabled={busy !== null} onClick={() => void remove(server)} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40" aria-label={`Remove ${server.name}`}><Trash2 size={14} /></button>
                    </div>
                  </div>
                  {result && (
                    <div role="status" className={cn("mt-3 rounded-lg px-3 py-2 text-[12px]", result.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
                      {result.ok ? (
                        <span className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-px shrink-0" /> Connected{result.tools?.length ? ` · ${result.tools.length} tool${result.tools.length === 1 ? "" : "s"}: ${result.tools.map((tool) => tool.name).join(", ")}` : " · no tools advertised"}</span>
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
