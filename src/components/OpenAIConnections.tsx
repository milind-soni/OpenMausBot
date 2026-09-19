import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

export interface OpenAIConnection {
  instanceId: string;
  displayName: string;
  url: string;
  auth: "bearer" | "none";
  configured: boolean;
  model: string;
  tools: boolean;
  provider?: string;
  legacy?: boolean;
  usedBy?: string[];
  isDefault?: boolean;
}

export interface OpenAIConnectionDraft {
  displayName: string;
  url: string;
  auth: "bearer" | "none";
  key: string;
  model: string;
  tools: boolean;
  provider?: string;
}

interface Verdict {
  ok: boolean;
  check: "authentication" | "models" | "response";
  models: string[];
  reason?: string;
}

const collection = "/api/instances/openai-compatible";
const connectionPath = (id: string) => `/api/instances/${encodeURIComponent(id)}/openai-compatible`;
const inputClass = "w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-accent/60 focus:outline-none disabled:opacity-60";
const buttonClass = "rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-50";

/** An omitted key retains only this connection's existing credential. */
export function connectionInput(draft: OpenAIConnectionDraft) {
  return {
    displayName: draft.displayName.trim(), url: draft.url.trim(), auth: draft.auth,
    model: draft.model.trim(), tools: draft.tools,
    ...(draft.provider ? { provider: draft.provider } : {}),
    ...(draft.auth === "bearer" && draft.key.trim() ? { key: draft.key.trim() } : {}),
  };
}

export function requiresConnectionKey(draft: OpenAIConnectionDraft, saved?: OpenAIConnection, keyEdited = false): boolean {
  return draft.auth === "bearer" && !draft.key.trim() &&
    (keyEdited || !(saved?.auth === "bearer" && saved.configured && draft.url.trim() === saved.url));
}

async function saveConnection(draft: OpenAIConnectionDraft, instanceId?: string) {
  const input = connectionInput(draft);
  if (window.ogb?.saveOpenAIConnection && !window.ogb.remoteClient?.active) {
    return window.ogb.saveOpenAIConnection({ ...input, ...(instanceId ? { instanceId } : {}) });
  }
  return api(instanceId ? connectionPath(instanceId) : collection, {
    method: instanceId ? "PATCH" : "POST", body: JSON.stringify(input),
  });
}

async function removeConnection(instanceId: string) {
  if (window.ogb?.removeOpenAIConnection && !window.ogb.remoteClient?.active) {
    return window.ogb.removeOpenAIConnection(instanceId);
  }
  return api(connectionPath(instanceId), { method: "DELETE" });
}

export function OpenAIConnectionEditor({ connection, onSaved, onCancel }: {
  connection?: OpenAIConnection;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<OpenAIConnectionDraft>(() => ({
    displayName: connection?.displayName ?? "", url: connection?.url ?? "",
    auth: connection?.auth ?? "bearer", key: "", model: connection?.model ?? "",
    tools: connection?.tools ?? true, provider: connection?.provider,
  }));
  const [keyEdited, setKeyEdited] = useState(false);
  const [busy, setBusy] = useState<"save" | "catalog" | "response" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const change = (patch: Partial<OpenAIConnectionDraft>) => {
    generation.current++;
    setDraft((current) => ({ ...current, ...patch }));
    if (patch.key !== undefined) setKeyEdited(true);
    setVerdict(null);
    if (patch.url !== undefined || patch.auth !== undefined || patch.key !== undefined) setModels([]);
    setError(null);
  };
  const missingKey = requiresConnectionKey(draft, connection, keyEdited);
  const valid = Boolean(draft.displayName.trim() && draft.url.trim() && !missingKey);

  const run = async (kind: "save" | "catalog" | "response") => {
    if (busy || !valid || (kind === "response" && !draft.model.trim())) return;
    const request = ++generation.current;
    setBusy(kind);
    setError(null);
    setVerdict(null);
    try {
      if (kind === "save") {
        await saveConnection(draft, connection?.instanceId);
        if (generation.current === request) onSaved();
      } else {
        const result = await api<Verdict>(`${collection}/test`, {
          method: "POST", body: JSON.stringify({ ...connectionInput(draft), instanceId: connection?.instanceId, kind }),
        });
        if (generation.current === request) {
          setVerdict(result);
          if (result.ok && result.check === "models") setModels(result.models);
        }
      }
    } catch (failure) {
      if (generation.current === request) setError(failure instanceof Error ? failure.message : t("connections.failed"));
    } finally {
      if (generation.current === request) setBusy(null);
    }
  };

  return (
    <form aria-label={t(connection ? "connections.edit" : "connections.add")} onSubmit={(event) => { event.preventDefault(); void run("save"); }}
      className="space-y-3 rounded-xl border border-hairline/50 bg-panel p-3">
      <h3 className="text-[13px] font-semibold text-ink">{t(connection ? "connections.edit" : "connections.add")}</h3>
      <fieldset disabled={Boolean(busy)} className="min-w-0 space-y-3">
        <label className="block space-y-1 text-[12px] text-ink-secondary">
          <span>{t("connections.name")}</span>
          <input autoFocus required maxLength={100} autoComplete="off" value={draft.displayName} onChange={(event) => change({ displayName: event.target.value })} className={inputClass} placeholder={t("connections.nameExample")} />
        </label>
        <label className="block space-y-1 text-[12px] text-ink-secondary">
          <span>{t("connections.url")}</span>
          <input required type="url" autoComplete="off" spellCheck={false} value={draft.url} onChange={(event) => change({ url: event.target.value })} className={inputClass} placeholder="https://api.example.com/v1" />
        </label>
        <label className="block space-y-1 text-[12px] text-ink-secondary">
          <span>{t("connections.auth")}</span>
          <select value={draft.auth} onChange={(event) => change({ auth: event.target.value as "bearer" | "none", key: "" })} className={inputClass}>
            <option value="bearer">{t("connections.bearer")}</option>
            <option value="none">{t("connections.noAuth")}</option>
          </select>
        </label>
        {draft.auth === "bearer" && (
          <label className="block space-y-1 text-[12px] text-ink-secondary">
            <span>{t("connections.key")}</span>
            <input type="password" aria-label={t("connections.key")} autoComplete="new-password" spellCheck={false} value={draft.key}
              onChange={(event) => change({ key: event.target.value })} className={inputClass}
              aria-describedby={`${id}-key-help`} placeholder={t(connection?.configured ? "connections.keepKey" : "connections.enterKey")} />
            <span id={`${id}-key-help`} className="block text-[11.5px] leading-relaxed">
              {t(keyEdited && !draft.key.trim() ? "connections.erasedKey" : connection?.configured && draft.url.trim() !== connection.url ? "connections.changedUrl" : "connections.keyHelp")}
            </span>
          </label>
        )}
        <label className="block space-y-1 text-[12px] text-ink-secondary">
          <span>{t("connections.model")}</span>
          <input list={`${id}-models`} autoComplete="off" spellCheck={false} value={draft.model} onChange={(event) => change({ model: event.target.value })} className={inputClass} placeholder={t("connections.modelExample")} />
          <datalist id={`${id}-models`}>{models.map((model) => <option key={model} value={model} />)}</datalist>
        </label>
        <label className="flex items-start gap-2 text-[12px] text-ink-secondary">
          <input type="checkbox" checked={draft.tools} onChange={(event) => change({ tools: event.target.checked })} className="mt-0.5 accent-accent" />
          <span>{t("connections.tools")}</span>
        </label>
      </fieldset>
      <div className="space-y-2 border-t border-hairline/40 pt-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={Boolean(busy) || !valid} onClick={() => void run("catalog")} className={buttonClass}>{t("connections.testCatalog")}</button>
          <button type="button" disabled={Boolean(busy) || !valid || !draft.model.trim()} onClick={() => void run("response")} className={buttonClass}>{t("connections.testResponse")}</button>
        </div>
        <p className="text-[11.5px] leading-relaxed text-ink-secondary">{t("connections.testHelp")}</p>
        {verdict && <p role="status" className={cn("break-words text-[12px]", verdict.ok ? "text-success" : "text-warning")}>
          {draft.auth === "bearer" && `${t(draft.key.trim() ? "connections.unsavedKey" : "connections.savedKey")} `}
          {verdict.ok ? t(verdict.check === "response" ? "connections.responseOk" : verdict.check === "authentication" ? "connections.authOk" : "connections.catalogOk", { count: verdict.models.length }) : verdict.reason ?? t("connections.testFailed")}
        </p>}
      </div>
      {error && <p role="alert" className="break-words text-[12px] text-danger">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {busy && <Loader2 size={14} className="animate-spin text-ink-secondary" aria-label={t("connections.working")} />}
        <button type="button" disabled={busy === "save"} onClick={onCancel} className={buttonClass}>{t("connections.cancel")}</button>
        <button type="submit" disabled={Boolean(busy) || !valid} className={cn(buttonClass, "border-accent/40 bg-accent text-white hover:brightness-110")}>{t("connections.save")}</button>
      </div>
    </form>
  );
}

export function OpenAIConnections() {
  const { state, refreshInstances } = useStore();
  const [connections, setConnections] = useState<OpenAIConnection[] | null>(null);
  const [editing, setEditing] = useState<OpenAIConnection | "new" | null>(null);
  const [deleting, setDeleting] = useState<OpenAIConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ connections: OpenAIConnection[] }>(collection, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setConnections(result.connections); setError(null); } })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("connections.failed")); });
    return () => controller.abort();
  }, [revision, state.instances]);
  const refresh = () => {
    setRevision((value) => value + 1);
    void refreshInstances().catch(() => {});
  };
  const remove = async () => {
    if (!deleting || busy) return;
    const connection = deleting;
    setDeleting(null);
    setBusy(true);
    setError(null);
    try {
      await removeConnection(connection.instanceId);
      if (alive.current) refresh();
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : t("connections.failed"));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section aria-label={t("connections.title")} className="space-y-3 rounded-xl border border-hairline/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-ink">{t("connections.title")}</h2>
        <button type="button" disabled={Boolean(editing) || busy || !connections} onClick={() => setEditing("new")} className={cn(buttonClass, "flex items-center gap-1")}><Plus size={13} />{t("connections.add")}</button>
      </div>
      <p className="text-[12px] leading-relaxed text-ink-secondary">{t("connections.subtitle")}</p>
      {!connections && !error && <p role="status" className="text-[12px] text-ink-secondary">{t("connections.loading")}</p>}
      {connections?.length === 0 && <p className="text-[12px] text-ink-secondary">{t("connections.empty")}</p>}
      {connections?.map((connection) => (
        <div key={connection.instanceId} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-inset p-3">
          <div className="min-w-0 flex-1 basis-40">
            <div className="break-words text-[13px] font-medium text-ink">{connection.displayName}</div>
            <div className="mt-0.5 break-all text-[11.5px] text-ink-secondary">{connection.url}</div>
            <div className="mt-1 text-[11.5px] text-ink-secondary">{t(connection.auth === "none" ? "connections.noAuth" : connection.configured ? "connections.keyStored" : "connections.keyMissing")}</div>
            {Boolean(connection.usedBy?.length) && <div className="mt-1 break-words text-[11.5px] text-ink-secondary">{t("connections.usedBy", { names: connection.usedBy!.join(", ") })}</div>}
            {(connection.isDefault || connection.instanceId === "openaiCompat") && <div className="mt-1 text-[11.5px] text-ink-secondary">{t("connections.existing")}</div>}
          </div>
          <div className="flex flex-wrap gap-1">
            <button type="button" disabled={Boolean(editing) || busy} aria-label={t("connections.editNamed", { name: connection.displayName })} onClick={() => setEditing(connection)} className={buttonClass}>{t("connections.editShort")}</button>
            <button type="button" disabled={Boolean(editing) || busy || connection.instanceId === "openaiCompat" || Boolean(connection.usedBy?.length) || connection.isDefault}
              aria-label={t("connections.removeNamed", { name: connection.displayName })} title={t("connections.removeHelp")} onClick={() => setDeleting(connection)} className={buttonClass}>{t("connections.remove")}</button>
          </div>
        </div>
      ))}
      {error && <div role="alert" className="text-[12px] text-danger"><p className="break-words">{error}</p><button type="button" onClick={refresh} className="mt-1 underline">{t("connections.retry")}</button></div>}
      {editing && <OpenAIConnectionEditor key={editing === "new" ? "new" : editing.instanceId} connection={editing === "new" ? undefined : editing}
        onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      <ConfirmDialog open={Boolean(deleting)} title={t("connections.removeTitle")} body={t("connections.removeBody", { name: deleting?.displayName ?? "" })}
        confirmLabel={t("connections.remove")} onCancel={() => setDeleting(null)} onConfirm={() => void remove()} />
    </section>
  );
}
