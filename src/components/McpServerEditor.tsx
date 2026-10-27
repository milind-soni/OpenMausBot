import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { readMcpPaste, type McpPasteError } from "@/lib/mcp-paste";

import { McpResultBudgetField, withResultBudget, type McpMessage } from "./McpResultBudgetField";
import { McpSecretRows } from "./McpSecretRows";
import { Select } from "./Select";
import { draftBody, draftFor, draftFromPaste, emptyDraft, isRemoteMcpListing, soleKey, type McpDraft, type McpServerListing } from "./mcp-draft";

export interface McpServerSubmission {
  name: string;
  body: Record<string, unknown>;
  /** On a Team Cloud, "Only for me": the key kept as this person's own. */
  ownKey?: string;
}

const FIELD = "mt-1.5 w-full rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent";
const LABEL = "text-[12px] font-medium text-ink-secondary";

function where(draft: McpDraft): string {
  if (draft.transport === "stdio") return draft.command;
  try { return new URL(draft.url).host; } catch { return draft.url; }
}

/** Add: one box for a link, a setup command or a config block, and the form only for what it couldn't fill. Edit: the
 * form, or with `fixKeys` only the header values, typed again. */
export function McpServerEditor({ server, fixKeys = false, taken, team, busy, onCancel, onSubmit }: {
  server?: McpServerListing;
  fixKeys?: boolean;
  taken: readonly string[];
  team: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (items: McpServerSubmission[]) => void;
}) {
  const adding = !server;
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<McpDraft[]>(() => server ? [draftFor(server)] : []);
  const [pasteError, setPasteError] = useState<McpPasteError | null>(null);
  const keysOnly = fixKeys && server !== undefined && isRemoteMcpListing(server);
  const [details, setDetails] = useState(!adding && !keysOnly);
  const [onlyMe, setOnlyMe] = useState(false);
  const [error, setError] = useState<McpMessage | null>(null);
  const draft = drafts.length === 1 ? drafts[0]! : null;
  const setDraft = (update: (current: McpDraft) => McpDraft) => setDrafts((current) => current.length === 1 ? [update(current[0]!)] : current);
  const savedOAuth = server && isRemoteMcpListing(server) ? server.oauth : undefined;
  const secretKept = Boolean(savedOAuth?.clientSecretConfigured && !draft?.oauthForgetSecret);
  const canKeepOwn = team && adding && draft !== null && soleKey(draft) !== null;

  const paste = (value: string) => {
    setText(value);
    setError(null);
    const read = readMcpPaste(value, taken);
    setPasteError(read && !read.ok ? read.error : null);
    setDrafts((current) => read?.ok ? read.servers.map(draftFromPaste) : !details ? [] : current.length === 1 ? current : [emptyDraft()]);
  };

  const submit = () => {
    const items: McpServerSubmission[] = [];
    for (const each of drafts) {
      const prepared = withResultBudget(each.resultBudget, () => draftBody(each, server));
      if (!prepared.ok) { setError(prepared.error); return; }
      const ownKey = canKeepOwn && onlyMe ? soleKey(each) : null;
      items.push({ name: each.name.trim(), body: prepared.body, ...(ownKey ? { ownKey } : {}) });
    }
    setError(null);
    onSubmit(items);
  };

  const missing = !details && drafts.some((each) => each.urlGap || each.headers.some((row) => row.gap) || each.env.some((row) => row.gap));

  return (
    <div data-mcp-editor className="mt-4 rounded-2xl border border-hairline/60 bg-card p-4 sm:p-5">
      <div className="text-[14px] font-medium text-ink">{adding ? t("mcp.editorNew") : t(keysOnly ? "mcp.fixKeys.title" : "mcp.editorEdit", { name: server.name })}</div>
      {keysOnly && draft && !details && (
        <div className="mt-3 space-y-3">
          <p className="text-[12px] leading-relaxed text-ink-secondary">{t("mcp.fixKeys.hint")}</p>
          {draft.headers.some((row) => row.name.trim())
            ? <McpSecretRows kind="header" valuesOf="named" placeholder={t("mcp.fixKeys.placeholder")} rows={draft.headers} onChange={(headers) => setDraft((current) => ({ ...current, headers }))} />
            : <McpSecretRows kind="header" rows={draft.headers} onChange={(headers) => setDraft((current) => ({ ...current, headers }))} />}
        </div>
      )}
      {adding && (
        <label className="mt-3 block">
          <span className="text-[13px] text-ink">{t("mcp.paste.prompt")}</span>
          <textarea autoFocus aria-label={t("mcp.paste.label")} value={text} onChange={(event) => paste(event.target.value)} spellCheck={false} rows={3}
            placeholder="https://mcp.example.com/mcp"
            className="mt-2 w-full resize-y rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-accent" />
        </label>
      )}
      {pasteError && <p role="alert" className="mt-2 text-[12px] leading-relaxed text-danger">{t(pasteError)}</p>}
      {adding && text.trim() && drafts.length > 0 && !pasteError && (
        <p role="status" className="mt-2 text-[12px] text-ink-secondary">
          {draft ? t("mcp.paste.foundOne", { name: draft.name, where: where(draft) }) : t("mcp.paste.foundMany", { count: drafts.length, names: drafts.map((each) => each.name).join(", ") })}
        </p>
      )}
      {missing && (
        <div className="mt-3 space-y-3">
          {drafts.map((each, index) => (
            <div key={index} className="space-y-3">
              {drafts.length > 1 && (each.urlGap || each.headers.some((row) => row.gap) || each.env.some((row) => row.gap)) && <div className="text-[12px] font-medium text-ink">{each.name}</div>}
              {each.urlGap && (
                <label className="block">
                  <span className={LABEL}>{t("mcp.field.url")}</span>
                  <input value={each.url} spellCheck={false} onChange={(event) => setDrafts((current) => current.map((other, at) => at === index ? { ...other, url: event.target.value } : other))} className={FIELD} />
                  <span className="mt-1 block text-[11px] text-warning">{t("mcp.paste.urlMissing")}</span>
                </label>
              )}
              <McpSecretRows kind="header" valuesOf="gaps" rows={each.headers} onChange={(headers) => setDrafts((current) => current.map((other, at) => at === index ? { ...other, headers } : other))} />
              <McpSecretRows kind="env" valuesOf="gaps" rows={each.env} onChange={(env) => setDrafts((current) => current.map((other, at) => at === index ? { ...other, env } : other))} />
            </div>
          ))}
        </div>
      )}
      {(adding || keysOnly) && drafts.length <= 1 && (
        <button type="button" aria-expanded={details} onClick={() => { setDetails(!details); if (!drafts.length) setDrafts([emptyDraft()]); }}
          className="mt-3 inline-flex items-center gap-1 text-[12px] font-medium text-ink-secondary hover:text-ink">
          {details ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {t("mcp.details")}
        </button>
      )}
      {details && draft && (
        <div className="mt-3">
          {adding && (
            <div className="inline-flex rounded-lg bg-raised p-0.5" role="radiogroup" aria-label={t("mcp.field.type")}>
              {(["remote", "stdio"] as const).map((transport) => (
                <button key={transport} type="button" role="radio" aria-checked={draft.transport === transport} onClick={() => setDraft((current) => ({ ...current, transport }))}
                  className={cn("rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors", draft.transport === transport ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}>
                  {t(transport === "stdio" ? "mcp.transport.stdio" : "mcp.transport.remote")}
                </button>
              ))}
            </div>
          )}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className={LABEL}>{t("mcp.field.name")}</span>
              <input disabled={!adding} value={draft.name} maxLength={32} placeholder="github" className={cn(FIELD, "disabled:opacity-60")}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value.toLowerCase() }))} />
            </label>
            {draft.transport === "remote" ? (
              <>
                <label className="block">
                  <span className={LABEL}>{t("mcp.field.url")}</span>
                  <input autoFocus={!adding} value={draft.url} spellCheck={false} placeholder="https://mcp.example.com/mcp" className={FIELD}
                    onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} />
                  {draft.urlGap && <span className="mt-1 block text-[11px] text-warning">{t("mcp.paste.urlMissing")}</span>}
                </label>
                <label className="block">
                  <span className={LABEL}>{t("mcp.field.type")}</span>
                  <Select className="mt-1.5 w-full" value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value === "sse" ? "sse" : "http" }))}>
                    <option value="http">{t("mcp.type.http")}</option>
                    <option value="sse">{t("mcp.type.sse")}</option>
                  </Select>
                </label>
                <div className="sm:col-span-2">
                  <div className={cn(LABEL, "mb-1.5")}>{t("mcp.field.headerRows")}</div>
                  <McpSecretRows kind="header" rows={draft.headers} onChange={(headers) => setDraft((current) => ({ ...current, headers }))} />
                  <span className="mt-1.5 block text-[11px] text-ink-secondary">{t("mcp.headersHint")}</span>
                </div>
                <div className="sm:col-span-2">
                  <div className="text-[12px] font-medium text-ink">{t("mcp.oauth.title")}</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-secondary">{savedOAuth ? t("mcp.oauth.hintRedirect", { uri: savedOAuth.redirectUri }) : t("mcp.oauth.hint")}</p>
                  <div className="mt-2 grid gap-4 sm:grid-cols-2">
                    <label className="block">
                      <span className={LABEL}>{t("mcp.oauth.clientId")}</span>
                      <input value={draft.oauthClientId} spellCheck={false} autoComplete="off" className={cn(FIELD, "font-mono text-[12px]")}
                        onChange={(event) => setDraft((current) => ({ ...current, oauthClientId: event.target.value }))} />
                    </label>
                    <label className="block">
                      <span className="flex items-center justify-between gap-2 text-[12px] font-medium text-ink-secondary">
                        {t("mcp.oauth.clientSecret")}
                        {secretKept && (
                          <button type="button" onClick={() => setDraft((current) => ({ ...current, oauthClientSecret: "", oauthForgetSecret: true }))} className="text-[11px] font-normal text-ink-secondary underline-offset-2 hover:text-ink hover:underline">
                            {t("mcp.oauth.removeSecret")}
                          </button>
                        )}
                      </span>
                      <input type="password" value={draft.oauthClientSecret} autoComplete="new-password" className={cn(FIELD, "font-mono text-[12px]")}
                        placeholder={secretKept ? t("mcp.oauth.secretSaved") : t("mcp.oauth.secretOptional")}
                        onChange={(event) => setDraft((current) => ({ ...current, oauthClientSecret: event.target.value }))} />
                    </label>
                    <label className="block sm:col-span-2">
                      <span className={LABEL}>{t("mcp.oauth.scopes")}</span>
                      <input value={draft.oauthScopes} placeholder="offline_access api://my-app/mcp.read" spellCheck={false} className={cn(FIELD, "font-mono text-[12px]")}
                        onChange={(event) => setDraft((current) => ({ ...current, oauthScopes: event.target.value }))} />
                    </label>
                  </div>
                </div>
              </>
            ) : (
              <>
                <label className="block">
                  <span className={LABEL}>{t("mcp.field.command")}</span>
                  <input autoFocus={!adding} value={draft.command} placeholder="npx" className={FIELD}
                    onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} />
                </label>
                <label className="block sm:col-span-2">
                  <span className={LABEL}>{t("mcp.field.args")}</span>
                  <textarea value={draft.args} placeholder={"-y\n@modelcontextprotocol/server-github"} rows={4} className={cn(FIELD, "resize-y font-mono text-[12px]")}
                    onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))} />
                </label>
                <div className="sm:col-span-2">
                  <div className={cn(LABEL, "mb-1.5")}>{t("mcp.field.envRows")}</div>
                  <McpSecretRows kind="env" rows={draft.env} onChange={(env) => setDraft((current) => ({ ...current, env }))} />
                </div>
              </>
            )}
            <McpResultBudgetField value={draft.resultBudget} onChange={(resultBudget) => setDraft((current) => ({ ...current, resultBudget }))} />
          </div>
        </div>
      )}
      {team && adding && drafts.length > 0 && (
        <div data-mcp-team-scope className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg bg-raised/50 px-3 py-2 text-[12px]">
          <span className="text-ink-secondary">{t(canKeepOwn && onlyMe ? "mcp.team.onlyMeOn" : "mcp.team.everyone")}</span>
          {canKeepOwn && (
            <label className="flex items-center gap-1.5 text-ink">
              <input type="checkbox" checked={onlyMe} onChange={(event) => setOnlyMe(event.target.checked)} /> {t("mcp.team.onlyMe")}
            </label>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{t(error.key, error.params)}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised">{t("mcp.cancel")}</button>
        <button type="button" disabled={busy || !drafts.length} onClick={submit}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white disabled:opacity-50">
          {busy && <Loader2 size={13} className="animate-spin" />} {t(adding ? "mcp.add" : "mcp.save")}
        </button>
      </div>
    </div>
  );
}
