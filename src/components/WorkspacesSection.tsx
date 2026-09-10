// App settings → Workspaces: the operator's view of the client workspaces on
// this server, through the fleet agent (server/fleet-agent.ts). Create one,
// add or remove a person, suspend, resume, delete, upgrade all. Enterprise
// `admin` entitlement, and only where an agent exists.
import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { formatUsd, hasFiniteCost } from "@/lib/usage";
import { ConfirmDialog } from "./ConfirmDialog";
import { CopyLink } from "./PeopleSection";
import { Card } from "./SettingsPrimitives";

export interface FleetWorkspaceView {
  slug: string;
  host: string;
  port: number;
  status: "running" | "suspended";
  createdAt: string;
  live: string;
  usage: { month: string; turns: number; costUsd: number | null; billableUsd: number | null };
}

export interface FleetView {
  domain: string;
  operator: string | null;
  workspaces: FleetWorkspaceView[];
}

export function workspacesAvailable(config: ConfigStatus | null | undefined): boolean {
  return config?.edition?.features?.includes("admin") === true && config?.fleet?.available === true;
}

const fetchFleet = (): Promise<FleetView> => api("/api/fleet");

/** The list alone, so it renders the same from a fetch or a fixture. */
export function WorkspacesTable({ fleet, onAct, busy }: { fleet: FleetView; onAct: (slug: string, action: "suspend" | "resume" | "delete" | "users") => void; busy: string | null }) {
  if (fleet.workspaces.length === 0) return <div className="text-[13px] text-ink-secondary">{t("workspaces.empty", { domain: fleet.domain })}</div>;
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-5 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
        <span>{t("workspaces.colWorkspace")}</span>
        <span className="text-right">{t("workspaces.colState")}</span>
        <span className="text-right">{t("workspaces.colMonth")}</span>
        <span />
      </div>
      {fleet.workspaces.map((workspace) => {
        const suspended = workspace.status === "suspended";
        const state = suspended ? t("workspaces.suspended") : workspace.live === "active" ? t("workspaces.running") : workspace.live;
        return (
          <div key={workspace.slug} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 border-b border-hairline/20 py-2 text-[13px]">
            <span className="min-w-0">
              <span className="block truncate text-ink">{workspace.slug}</span>
              <a href={`https://${workspace.host}`} target="_blank" rel="noreferrer" className="block truncate text-[12px] text-accent hover:underline">{workspace.host}</a>
            </span>
            <span className={cn("text-right", suspended ? "text-warning" : workspace.live === "active" ? "text-success" : "text-danger")}>{state}</span>
            <span className="text-right tabular-nums text-ink" title={t("workspaces.turns", { turns: String(workspace.usage.turns) })}>
              {hasFiniteCost(workspace.usage.costUsd) ? formatUsd(workspace.usage.costUsd) : "—"}
              {hasFiniteCost(workspace.usage.billableUsd) && <span className="text-ink-secondary"> · {formatUsd(workspace.usage.billableUsd)}</span>}
            </span>
            <span className="flex items-center justify-end gap-2 text-[12px]">
              <button type="button" disabled={busy !== null} onClick={() => onAct(workspace.slug, "users")} className="text-ink-secondary hover:text-ink disabled:opacity-50">{t("workspaces.users")}</button>
              <button type="button" disabled={busy !== null} onClick={() => onAct(workspace.slug, suspended ? "resume" : "suspend")} className="text-ink-secondary hover:text-ink disabled:opacity-50">{suspended ? t("workspaces.resume") : t("workspaces.suspend")}</button>
              <button type="button" disabled={busy !== null} onClick={() => onAct(workspace.slug, "delete")} className="text-danger hover:underline disabled:opacity-50">{t("workspaces.delete")}</button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function NewWorkspaceForm({ domain, onCreated, disabled }: { domain: string; onCreated: (log: string[], created: { slug: string; admin: string }) => void; disabled: boolean }) {
  const [slug, setSlug] = useState("");
  const [admin, setAdmin] = useState("");
  const [members, setMembers] = useState("");
  const [cap, setCap] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        slug: slug.trim().toLowerCase(),
        admins: [admin.trim()],
        members: members.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean),
        ...(cap.trim() ? { cap: Number(cap) } : {}),
        ...(anthropicKey.trim() ? { anthropicKey: anthropicKey.trim() } : {}),
      };
      const result: { log?: string[] } = await api("/api/fleet/workspaces", { method: "POST", body: JSON.stringify(body) });
      setSlug(""); setAdmin(""); setMembers(""); setCap(""); setAnthropicKey("");
      onCreated(result.log ?? [], { slug: body.slug, admin: body.admins[0]! });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const field = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50";
  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t("workspaces.name")}
          <div className="flex items-center gap-1">
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme" pattern="[a-z][a-z0-9-]{1,30}" required disabled={disabled || saving} aria-label={t("workspaces.name")} className={field} />
            <span className="whitespace-nowrap text-[12px] text-ink-secondary">.{domain}</span>
          </div>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t("workspaces.adminEmail")}
          <input value={admin} onChange={(e) => setAdmin(e.target.value)} type="email" required disabled={disabled || saving} aria-label={t("workspaces.adminEmail")} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t("workspaces.members")}
          <input value={members} onChange={(e) => setMembers(e.target.value)} placeholder="bob@acme.test, @acme.test" disabled={disabled || saving} aria-label={t("workspaces.members")} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t("workspaces.cap")}
          <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" placeholder="50" disabled={disabled || saving} aria-label={t("workspaces.cap")} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary sm:col-span-2">
          {t("workspaces.anthropicKey")}
          <input value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} type="password" autoComplete="off" placeholder="sk-ant-…" disabled={disabled || saving} aria-label={t("workspaces.anthropicKey")} className={field} />
        </label>
      </div>
      <p className="text-[11.5px] leading-relaxed text-ink-secondary">{t("workspaces.createHint")}</p>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <div className="flex justify-end">
        <button type="submit" disabled={disabled || saving} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-60">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}{saving ? t("workspaces.creating") : t("workspaces.create")}
        </button>
      </div>
    </form>
  );
}

function UsersForm({ slug, onDone }: { slug: string; onDone: (log: string[]) => void }) {
  const [email, setEmail] = useState("");
  const [chatOnly, setChatOnly] = useState(false);
  const [busy, setBusy] = useState<"add" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: "add" | "remove") => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      const result: { log?: string[] } = await api(`/api/fleet/workspaces/${encodeURIComponent(slug)}/users`, { method: "POST", body: JSON.stringify({ action, email: email.trim(), chatOnly }) });
      setEmail("");
      onDone(result.log ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mt-2 rounded-lg border border-hairline/40 p-3">
      <div className="mb-2 text-[12.5px] font-medium text-ink">{t("workspaces.usersTitle", { slug })}</div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="text" placeholder="person@example.com or @example.com" aria-label={t("workspaces.email")} disabled={busy !== null} className="min-w-[16rem] flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50" />
        <label className="flex items-center gap-1.5 text-[12px] text-ink-secondary"><input type="checkbox" checked={chatOnly} onChange={(e) => setChatOnly(e.target.checked)} disabled={busy !== null} />{t("workspaces.chatOnly")}</label>
        <button type="button" disabled={busy !== null || !email.trim()} onClick={() => void run("add")} className="rounded-lg bg-raised px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50">{busy === "add" ? t("workspaces.working") : t("workspaces.addUser")}</button>
        <button type="button" disabled={busy !== null || !email.trim()} onClick={() => void run("remove")} className="rounded-lg px-3 py-1.5 text-[12px] text-danger hover:underline disabled:opacity-50">{busy === "remove" ? t("workspaces.working") : t("workspaces.removeUser")}</button>
      </div>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

export function WorkspacesSection({ load = fetchFleet }: { load?: () => Promise<FleetView> }) {
  const { state } = useStore();
  const [fleet, setFleet] = useState<FleetView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [usersFor, setUsersFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ slug: string; keepData: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setFleet(await load()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [load]);
  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (slug: string, action: "suspend" | "resume" | "delete" | "users") => {
    if (action === "users") { setUsersFor((current) => (current === slug ? null : slug)); return; }
    if (action === "delete") { setConfirm({ slug, keepData: false }); return; }
    setBusy(slug);
    setError(null);
    try {
      const result: { log?: string[] } = await api(`/api/fleet/workspaces/${encodeURIComponent(slug)}/${action}`, { method: "POST" });
      setLog(result.log ?? []);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!confirm) return;
    const { slug, keepData } = confirm;
    setConfirm(null);
    setBusy(slug);
    setError(null);
    try {
      const result: { log?: string[] } = await api(`/api/fleet/workspaces/${encodeURIComponent(slug)}`, { method: "DELETE", body: JSON.stringify({ keepData }) });
      setLog(result.log ?? []);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const upgrade = async () => {
    setBusy("*");
    setError(null);
    try {
      const result: { log?: string[] } = await api("/api/fleet/upgrade", { method: "POST" });
      setLog(result.log ?? [t("workspaces.upgraded")]);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!workspacesAvailable(state.config)) return null;
  return (
    <div className="flex flex-col gap-5">
      <Card title={t("workspaces.title")} subtitle={t("workspaces.subtitle")}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void refresh()} disabled={loading || busy !== null} className="flex items-center gap-1 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-50"><RefreshCw size={12} className={cn(loading && "animate-spin")} />{t("workspaces.refresh")}</button>
          <button type="button" onClick={() => setCreating((value) => !value)} disabled={busy !== null} className="ml-auto flex items-center gap-1.5 rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"><Plus size={13} />{t("workspaces.new")}</button>
          <button type="button" onClick={() => void upgrade()} disabled={busy !== null || !fleet?.workspaces.length} className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50">{busy === "*" ? t("workspaces.working") : t("workspaces.upgradeAll")}</button>
        </div>
        {creating && fleet && <div className="mb-4 rounded-xl border border-hairline/40 p-3"><NewWorkspaceForm domain={fleet.domain} disabled={busy !== null} onCreated={(lines, created) => { setCreating(false); setLog(lines); setInviteLink(`https://${created.slug}.${fleet.domain}/pair?email=${encodeURIComponent(created.admin)}`); void refresh(); }} /></div>}
        {inviteLink && <div className="mb-4"><CopyLink link={inviteLink} /></div>}
        {error && <p role="alert" className="mb-2 text-[12px] text-danger">{error}</p>}
        {fleet ? <WorkspacesTable fleet={fleet} onAct={(slug, action) => void act(slug, action)} busy={busy} /> : loading ? <div className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("common.checking")}</div> : null}
        {usersFor && <UsersForm slug={usersFor} onDone={(lines) => { setLog(lines); void refresh(); }} />}
        {log.length > 0 && (
          <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-inset p-2 text-[11.5px] text-ink-secondary">{log.join("\n")}</pre>
        )}
      </Card>
      <ConfirmDialog
        open={confirm !== null}
        title={t("workspaces.deleteTitle", { slug: confirm?.slug ?? "" })}
        body={t(confirm?.keepData ? "workspaces.deleteKeepHint" : "workspaces.deleteHint")}
        confirmLabel={t("workspaces.delete")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void remove()}
      />
      {confirm && (
        <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
          <input type="checkbox" checked={confirm.keepData} onChange={(e) => setConfirm({ ...confirm, keepData: e.target.checked })} />{t("workspaces.keepData")}
        </label>
      )}
    </div>
  );
}
