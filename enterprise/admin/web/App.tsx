import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, Clock3, KeyRound, Layers3, LoaderCircle, LogOut, Plus, RefreshCw, Search, Server, ShieldCheck, Users, X } from "lucide-react";
import appIcon from "../../../public/app-icon.svg?url";
import { invitationEmails, sendInvitations, workspaceSlug, type InvitationResult } from "./invitations";

const auth = createAuthClient({ baseURL: window.location.origin, basePath: "/api/auth", plugins: [emailOTPClient()] });
type Role = "admin" | "member";
type Person = { email: string; role: Role };
type Me = { email: string; name: string; platformAdmin: boolean };
type PublicConfig = { name: string; providers: ("google" | "github")[] };
type Workspace = { slug: string; name: string; host: string; status: string; runtime: "active" | "inactive" | "failed" | "unknown" | "missing" | null; checkedAt: number | null; role: Role | null; models: string[]; openrouterModels: string[]; error?: string | null };
type Invitation = Person & { id: string; status: string; expiresAt: number; createdAt: number };
type Provider = { id: "anthropic" | "openrouter"; configured: boolean; models: string[] };
type ProvidersResponse = { providers: Provider[] };
const providerName = (id: Provider["id"]) => id === "openrouter" ? "OpenRouter" : "Anthropic";
type Activity = { id: number; at: number; actor: string; action: string; workspace: string | null; detail: string };

class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly wrongAccount = false, readonly invitationId?: string) { super(message); }
}

async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET", credentials: "same-origin", signal: options.signal,
    ...(options.body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body) } : {}),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new RequestError(typeof body?.error === "string" ? body.error : "The request could not be completed. Please try again.", response.status, body?.wrongAccount === true, typeof body?.invitation?.id === "string" ? body.invitation.id : undefined);
  return body as T;
}

function useLoad<T>(path: string | null) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ path: string | null; data: T | null; error: Error | null; loading: boolean }>({ path, data: null, error: null, loading: Boolean(path) });
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({ path, data: previous.path === path ? previous.data : null, error: null, loading: Boolean(path) }));
    if (path) void api<T>(path, { signal: controller.signal }).then(
      data => { if (!controller.signal.aborted) setState({ path, data, error: null, loading: false }); },
      error => { if (!controller.signal.aborted) setState({ path, data: null, error, loading: false }); },
    );
    return () => controller.abort();
  }, [path, version]);
  return { ...(state.path === path ? state : { data: null, error: null, loading: Boolean(path) }), reload: () => setVersion(value => value + 1) };
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const lock = useRef(false);
  return { busy, error, run: async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause : new Error("Please try again.")); }
    finally { lock.current = false; setBusy(false); }
  } };
}

function ErrorNotice({ error, retry }: { error: Error | null; retry?: () => void }) {
  if (!error) return null;
  const expired = error instanceof RequestError && error.status === 401;
  return <div className="notice error" role="alert"><span>{error.message}</span>{expired
    ? <button className="text-button" onClick={() => window.location.reload()}>Sign in again</button>
    : retry && <button className="text-button" onClick={retry}>Try again</button>}</div>;
}

function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="loading" role="status"><LoaderCircle size={18} className="spin" />{label}</div>;
}

function Status({ value }: { value: string }) {
  const labels: Record<string, string> = { running: "Active", active: "Running", inactive: "Stopped", failed: "Failed", missing: "Service missing", unknown: "Status unavailable", provisioning: "Setting up", error: "Needs attention", suspended: "Suspended", retained: "Removed · data retained", pending: "Pending", accepted: "Accepted", revoked: "Revoked", expired: "Expired" };
  return <span className={`status status-${value}`}>{labels[value] ?? value}</span>;
}

function WorkspaceStatus({ workspace }: { workspace: Workspace }) {
  return <Status value={workspace.status === "running" ? workspace.runtime ?? "unknown" : workspace.status} />;
}

function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><Layers3 size={26} strokeWidth={1.4} /><h2>{title}</h2>{children && <div className="muted">{children}</div>}</div>;
}

function Modal({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("input:not([type=checkbox]):not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled)")?.focus();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} aria-labelledby={id} onClose={() => { if (!ref.current?.open) onClose(); }} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-header"><h2 id={id}>{title}</h2><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={20} /></button></div>
    {children}
  </dialog>;
}

const roleName = (role: Role | null) => role === "admin" ? "Workspace admin" : role === "member" ? "Member" : "Management only";
const date = (value: number) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const workspacePath = (slug: string) => `/api/workspaces/${encodeURIComponent(slug)}`;
const openWorkspace = (workspace: Workspace) => `https://${workspace.host}/api/auth/hosted/start`;
const routeNow = () => window.location.pathname + window.location.search;

function authReturnPath() {
  const path = window.location.pathname;
  return /^\/invite\/[\w-]+$/.test(path) || path === "/connect" ? routeNow() : "/workspaces";
}

function Login({ config, onSignedIn }: { config: PublicConfig; onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [otp, setOtp] = useState("");
  const action = useAction();
  const sendCode = () => action.run(async () => {
    const address = email.trim();
    const result = await auth.emailOtp.sendVerificationOtp({ email: address, type: "sign-in" });
    if (result.error) throw new Error(result.error.message ?? "The code could not be sent.");
    setSentTo(address); setOtp("");
  });
  const verify = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      const result = await auth.signIn.emailOtp({ email: sentTo, otp });
      if (result.error) throw new Error(result.error.message ?? "That code could not be verified.");
      onSignedIn();
    });
  };
  return <main className="auth-page"><div className="auth-card">
    <Brand name={config.name} />
    <div className="auth-heading"><h1>{sentTo ? "Check your email" : "Sign in"}</h1><p className="muted">{sentTo ? <>Enter the six-digit code sent to <strong>{sentTo}</strong>.</> : "Use the email address your administrator invited."}</p></div>
    <ErrorNotice error={action.error} />
    {sentTo ? <form onSubmit={verify}><fieldset disabled={action.busy}>
      <label>Sign-in code<input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, ""))} className="code-input" /></label>
      <button className="primary full" type="submit">{action.busy ? "Signing in…" : "Continue"}</button>
      <div className="inline-actions"><button type="button" className="text-button" onClick={() => void sendCode()}>Resend code</button><button type="button" className="text-button" onClick={() => { setSentTo(""); setOtp(""); }}>Use another email</button></div>
    </fieldset></form> : <>
      {config.providers.length > 0 && <div className="social-buttons">{config.providers.map(provider => <button key={provider} disabled={action.busy} onClick={() => void action.run(async () => {
        const result = await auth.signIn.social({ provider, callbackURL: new URL(authReturnPath(), window.location.origin).href });
        if (result.error) throw new Error(result.error.message ?? "Sign-in could not start.");
      })}>Continue with {provider === "google" ? "Google" : "GitHub"}</button>)}<div className="divider"><span>or use email</span></div></div>}
      <form onSubmit={event => { event.preventDefault(); void sendCode(); }}><fieldset disabled={action.busy}>
        <label>Email address<input type="email" autoComplete="email" required maxLength={320} value={email} onChange={event => setEmail(event.target.value)} placeholder="you@company.com" /></label>
        <button className="primary full" type="submit">{action.busy ? "Sending code…" : "Email me a code"}</button>
      </fieldset></form>
    </>}
    <p className="auth-note">Signing in does not connect your email account to a bot.</p>
  </div></main>;
}

function Brand({ name }: { name: string }) {
  return <div className="brand"><img className="brand-mark" src={appIcon} alt="" /><span>{name}<small>Admin</small></span></div>;
}

function ModelChoices({ provider, value, onChange, disabled = false }: { provider: Provider; value: string[]; onChange: (models: string[]) => void; disabled?: boolean }) {
  const visible = [...new Set([...provider.models, ...value])];
  return <fieldset className="model-choices" disabled={disabled}><legend>{providerName(provider.id)} models</legend>{visible.length ? visible.map(model => <label className="check-row" key={model}>
    <input type="checkbox" checked={value.includes(model)} onChange={event => onChange(event.target.checked ? [...value, model] : value.filter(item => item !== model))} /><span>{model}{!provider.models.includes(model) && " · No longer enabled; remove this assignment"}</span>
  </label>) : <p className="muted">No managed models are configured. Access can be added later.</p>}</fieldset>;
}

function CreateWorkspace({ onClose, onCreated, onChanged }: { onClose: () => void; onCreated: (slug: string) => void; onChanged: () => void }) {
  const provider = useLoad<ProvidersResponse>("/api/providers");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [addressEdited, setAddressEdited] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [openrouterModels, setOpenrouterModels] = useState<string[]>([]);
  const action = useAction();
  return <Modal title="Create workspace" onClose={onClose} busy={action.busy}>
    <p className="muted">A fresh space for one client or team. Nothing is copied from your own chats or other workspaces.</p>
    <form onSubmit={event => { event.preventDefault(); void action.run(async () => {
      try { await api("/api/workspaces", { method: "POST", body: { name: name.trim(), slug: slug.trim(), models, openrouterModels } }); onCreated(slug.trim()); }
      finally { onChanged(); }
    }); }}><fieldset disabled={action.busy}>
      <label>Workspace name<input autoFocus required maxLength={80} value={name} onChange={event => { setName(event.target.value); if (!addressEdited) setSlug(workspaceSlug(event.target.value)); }} placeholder="Acme team" /></label>
      <label>Workspace address<input required pattern="[a-z][a-z0-9-]{1,30}" minLength={2} maxLength={31} value={slug} onChange={event => { setAddressEdited(true); setSlug(event.target.value.toLowerCase()); }} placeholder="acme" aria-describedby="slug-hint" /></label>
      <p className="field-hint" id="slug-hint">2–31 lowercase letters, numbers or dashes. Start with a letter. This address cannot be changed.</p>
      <details className="form-details"><summary>Assign models <span className="muted">Optional · you can do this later</span></summary>{provider.loading ? <Loading label="Loading available models…" /> : provider.data?.providers.map(item => <ModelChoices key={item.id} provider={item} value={item.id === "openrouter" ? openrouterModels : models} onChange={item.id === "openrouter" ? setOpenrouterModels : setModels} />)}</details>
      {openrouterModels.length > 0 && <p className="field-hint">OpenRouter models use OpenCode. OpenCode must be installed on the workspace server.</p>}
      <ErrorNotice error={provider.error} retry={provider.reload} /><ErrorNotice error={action.error} />
      {action.busy && <p className="muted" role="status">Setting up the workspace. This may take a minute; keep this page open.</p>}
      <p className="footnote"><Users size={15} />Next, invite people into this workspace. You are not added as a member automatically.</p>
      <div className="form-footer"><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit" disabled={provider.loading || Boolean(provider.error)}>{action.busy ? "Creating…" : "Create workspace"}</button></div>
    </fieldset></form>
  </Modal>;
}

function Workspaces({ me, workspaces, navigate, reload, loading }: { me: Me; workspaces: Workspace[]; navigate: (path: string) => void; reload: () => void; loading: boolean }) {
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const visible = workspaces.filter(workspace => `${workspace.name} ${workspace.host}`.toLowerCase().includes(search.toLowerCase()));
  return <>
    <header className="page-header"><div><p className="eyebrow">Your organization</p><h1>Workspaces</h1><p className="muted">One shared space per team. A separate workspace for each client.</p></div><div className="inline-actions"><button aria-label="Refresh workspace status" disabled={loading} onClick={reload}><RefreshCw size={16} className={loading ? "spin" : undefined} />Refresh</button>{me.platformAdmin && <button className="primary" onClick={() => setCreating(true)}><Plus size={17} />New workspace</button>}</div></header>
    {workspaces.length > 0 && <div className="list-toolbar"><label className="search-field"><Search size={17} /><input aria-label="Search workspaces" type="search" placeholder="Find a workspace…" value={search} onChange={event => setSearch(event.target.value)} /></label><span className="muted">{workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}</span></div>}
    {!workspaces.length ? <Empty title={me.platformAdmin ? "Your next team starts here" : "No workspaces yet"}>{me.platformAdmin ? <><p>Create an empty workspace, choose its models, and invite its first people.</p><button className="primary" onClick={() => setCreating(true)}><Plus size={17} />Create workspace</button></> : "Accept your email invitation to see your workspace here."}</Empty> : !visible.length ? <Empty title="No matching workspaces">Try another name or address.</Empty> : <div className="table-wrap"><table><thead><tr><th>Workspace</th><th>Service</th><th>Your access</th><th>Models</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{visible.map(workspace => <tr key={workspace.slug}>
      <td><button className="workspace-name text-button" onClick={() => navigate(`/workspaces/${workspace.slug}`)}>{workspace.name}<ChevronRight size={15} /></button><span className="table-meta">{workspace.host}</span></td>
      <td><WorkspaceStatus workspace={workspace} />{workspace.checkedAt && <span className="table-meta">Checked {new Date(workspace.checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>}</td><td>{roleName(workspace.role)}</td><td>{workspace.models.length + workspace.openrouterModels.length ? `${workspace.models.length + workspace.openrouterModels.length} enabled` : "None enabled"}</td>
      <td>{workspace.role && workspace.status === "running" ? <a className="button small" href={openWorkspace(workspace)}>Open<ArrowUpRight size={15} /></a> : <button className="small" onClick={() => navigate(`/workspaces/${workspace.slug}`)}>View</button>}</td>
    </tr>)}</tbody></table></div>}
    {me.platformAdmin && <p className="footnote"><ShieldCheck size={15} />Platform administration does not grant access to workspace conversations.</p>}
    {creating && <CreateWorkspace onClose={() => setCreating(false)} onChanged={reload} onCreated={slug => { setCreating(false); navigate(`/workspaces/${slug}?tab=people&created=1`); }} />}
  </>;
}

function WorkspaceDetail({ workspace, me, navigate, reload, selectedTab, created, loading }: { workspace: Workspace; me: Me; navigate: (path: string) => void; reload: () => void; selectedTab: string | null; created: boolean; loading: boolean }) {
  const provider = useLoad<ProvidersResponse>(me.platformAdmin ? "/api/providers" : null);
  const [models, setModels] = useState(workspace.models);
  const [openrouterModels, setOpenrouterModels] = useState(workspace.openrouterModels);
  const [confirm, setConfirm] = useState<"suspend" | "resume" | "remove" | null>(null);
  const [typed, setTyped] = useState("");
  const action = useAction();
  const [saved, setSaved] = useState(false);
  const canManage = me.platformAdmin || workspace.role === "admin";
  const active = workspace.status !== "retained";
  const tabs = [{ id: "overview", name: "Overview" }, ...(canManage ? [{ id: "people", name: "People" }] : []), { id: "models", name: "Models" }, ...(me.platformAdmin ? [{ id: "hosting", name: "Hosting" }] : [])];
  const tab = tabs.some(item => item.id === selectedTab) ? selectedTab : "overview";
  const selectTab = (next: string) => navigate(`/workspaces/${workspace.slug}?tab=${next}`);
  const assignedModels = workspace.models.join("\n"), assignedOpenrouter = workspace.openrouterModels.join("\n");
  // A status-only refresh must not discard an unsaved model selection.
  useEffect(() => { setModels(assignedModels ? assignedModels.split("\n") : []); }, [assignedModels]);
  useEffect(() => { setOpenrouterModels(assignedOpenrouter ? assignedOpenrouter.split("\n") : []); }, [assignedOpenrouter]);
  const changeHosting = () => action.run(async () => {
    try {
      await api(workspacePath(workspace.slug) + (confirm === "remove" ? "" : `/${confirm}`), { method: confirm === "remove" ? "DELETE" : "POST", body: confirm === "remove" ? { confirm: typed } : {} });
      setConfirm(null); setTyped("");
    } finally { reload(); }
  });
  return <>
    <button className="text-button back" onClick={() => navigate("/workspaces")}><ArrowLeft size={16} />Workspaces</button>
    <header className="page-header"><div><p className="eyebrow">Workspace</p><h1>{workspace.name}</h1><div className="heading-meta"><WorkspaceStatus workspace={workspace} /><span className="muted">{workspace.host}</span></div></div><div className="inline-actions"><button aria-label="Refresh workspace status" disabled={loading} onClick={reload}><RefreshCw size={16} className={loading ? "spin" : undefined} />Refresh</button>{workspace.role && workspace.status === "running" && <a className="button primary" href={openWorkspace(workspace)}>Open workspace<ArrowUpRight size={17} /></a>}</div></header>
    {created && <div className="notice success" role="status"><Check size={18} /><span>Workspace created. Invite its first administrator and team below.</span></div>}
    {workspace.error && <div className="notice error" role="alert">{workspace.error}</div>}
    {workspace.status === "running" && workspace.runtime !== "active" && <div className="notice"><Server size={18} /><span>{workspace.runtime === "unknown" || !workspace.runtime ? "The server status could not be checked. Refresh to try again; this does not mean the workspace was deleted." : "The workspace service is not running. Its data is still retained. Ask the platform administrator to check the server."}</span></div>}
    <nav className="workspace-tabs" aria-label="Workspace navigation">{tabs.map(item => <a key={item.id} href={`/workspaces/${workspace.slug}?tab=${item.id}`} aria-current={tab === item.id ? "page" : undefined} onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) { event.preventDefault(); selectTab(item.id); } }}>{item.name}</a>)}</nav>
    {tab === "overview" && <div className="detail-grid"><section className="panel"><div className="section-heading"><Layers3 size={20} /><h2>A shared space for this team</h2></div><p className="muted">Everyone you invite here uses the same bots, conversations, files, and routines. Use another workspace for another client or private work.</p><dl className="workspace-facts"><div><dt>Your access</dt><dd>{roleName(workspace.role)}</dd></div><div><dt>Workspace address</dt><dd>{workspace.host}</dd></div><div><dt>Managed models</dt><dd>{workspace.models.length + workspace.openrouterModels.length || "None assigned"}</dd></div></dl>{canManage && <button onClick={() => selectTab("people")}><Users size={16} />Manage people<ChevronRight size={16} /></button>}</section><section className="panel"><div className="section-heading"><ShieldCheck size={20} /><h2>Separate by design</h2></div><p className="muted">This workspace has its own data and member list. Creating it does not copy an administrator’s chats or give people access to other workspaces.</p>{!workspace.role && active ? <div className="notice compact">You manage this workspace, but cannot open its conversations. To join, invite your own email and accept it.</div> : <p className="field-hint">Your personal email and AI subscriptions are not connected when you accept an invitation.</p>}{me.platformAdmin && <button onClick={() => selectTab("models")}><KeyRound size={16} />Choose model access<ChevronRight size={16} /></button>}</section></div>}
    {tab === "people" && canManage && <PeopleList workspace={workspace} reloadWorkspaces={reload} me={me} />}
    {tab === "models" && <section className="panel model-panel"><div className="section-heading"><KeyRound size={20} /><h2>Models for {workspace.name}</h2></div><p className="muted">{me.platformAdmin ? "Select which centrally managed models this team can use. Provider keys stay with the platform administrator." : "These models are managed by your platform administrator. Contact them to change access."}</p>{me.platformAdmin && active ? <form onSubmit={event => { event.preventDefault(); setSaved(false); void action.run(async () => { try { await api(`${workspacePath(workspace.slug)}/providers`, { method: "POST", body: { models, openrouterModels } }); setSaved(true); } finally { reload(); } }); }}>
        {provider.loading ? <Loading /> : provider.data?.providers.map(item => <ModelChoices key={item.id} provider={item} value={item.id === "openrouter" ? openrouterModels : models} onChange={value => { (item.id === "openrouter" ? setOpenrouterModels : setModels)(value); setSaved(false); }} disabled={action.busy} />)}
        <p className="field-hint">Choose OpenRouter models in the OpenCode model picker. Refresh the engine catalog after saving. Existing bots keep their selected model; removed models can no longer run.</p>
        <ErrorNotice error={provider.error} retry={provider.reload} />
        <div className="inline-actions"><button className="primary" type="submit" disabled={action.busy || provider.loading || Boolean(provider.error)}>Save model access</button>{saved && <span className="saved" role="status"><Check size={15} />Saved</span>}</div>
      </form> : workspace.models.length + workspace.openrouterModels.length ? <ul className="plain-list">{workspace.models.map(model => <li key={`anthropic:${model}`}>Anthropic · {model}</li>)}{workspace.openrouterModels.map(model => <li key={`openrouter:${model}`}>OpenRouter · {model}</li>)}</ul> : <p className="muted">No managed models are enabled.</p>}{me.platformAdmin && <p className="footnote">Missing a model? Add its ID in <button className="text-button" onClick={() => navigate("/providers")}>Providers</button> first.</p>}</section>}
    <ErrorNotice error={action.error} />
    {tab === "hosting" && me.platformAdmin && <div className="hosting-stack"><section className="panel"><div className="section-heading"><Server size={20} /><h2>Workspace service</h2><WorkspaceStatus workspace={workspace} /></div><p className="muted">{workspace.checkedAt ? `Service status checked at ${new Date(workspace.checkedAt).toLocaleString()}. This reports the server process, not an end-to-end connection test.` : "The current service status has not been confirmed."}</p><p className="field-hint">Suspending stops the service and member access. Conversations and files are kept.</p>{active && <div className="inline-actions">{workspace.status === "running" && <button onClick={() => setConfirm("suspend")}>Suspend workspace</button>}{workspace.status === "suspended" && <button className="primary" onClick={() => setConfirm("resume")}>Resume workspace</button>}</div>}</section><section className="panel hosting danger-zone"><div><h2>{active ? "Remove from service" : "Workspace removed"}</h2><p className="muted">{active ? "Members lose access. Files and conversations stay on the server; this is not a backup or permanent deletion. Restoring a removed workspace requires the server operator." : "Its data remains on the server. Contact the server operator to restore or permanently delete it."}</p></div>{active && <button className="danger-text" onClick={() => { setTyped(""); setConfirm("remove"); }}>Remove workspace</button>}</section></div>}
    {confirm && <Modal title={confirm === "remove" ? "Remove workspace?" : `${confirm === "suspend" ? "Suspend" : "Resume"} workspace?`} onClose={() => setConfirm(null)} busy={action.busy}>
      <p className="muted">{confirm === "remove" ? <>This removes <strong>{workspace.name}</strong> from service. Its data is retained on the server; it is not erased.</> : confirm === "suspend" ? "People will lose access until you resume this workspace. Its data will be kept." : "This will start the workspace again and restore access for its members."}</p>
      <form onSubmit={event => { event.preventDefault(); void changeHosting(); }}><fieldset disabled={action.busy}>{confirm === "remove" && <label>Type <strong>{workspace.slug}</strong> to confirm<input autoFocus value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" required /></label>}
        <ErrorNotice error={action.error} /><div className="form-footer"><button type="button" onClick={() => setConfirm(null)}>Cancel</button><button type="submit" className={confirm === "resume" ? "primary" : "danger"} disabled={confirm === "remove" && typed !== workspace.slug}>{action.busy ? "Working…" : confirm === "remove" ? "Remove · keep data" : confirm === "suspend" ? "Suspend workspace" : "Resume workspace"}</button></div>
      </fieldset></form>
    </Modal>}
  </>;
}

function People({ me, workspaces, selected, navigate, reloadWorkspaces }: { me: Me; workspaces: Workspace[]; selected: string | null; navigate: (path: string) => void; reloadWorkspaces: () => void }) {
  const manageable = workspaces.filter(workspace => me.platformAdmin || workspace.role === "admin");
  const workspace = manageable.find(item => item.slug === selected) ?? (!selected ? manageable[0] : undefined);
  return <>
    <header className="page-header"><div><p className="eyebrow">Workspace access</p><h1>People</h1><p className="muted">Choose a workspace, then manage everyone who shares it.</p></div></header>
    {manageable.length > 0 && <label className="workspace-select">Workspace<select value={workspace?.slug ?? ""} onChange={event => navigate(`/people?workspace=${event.target.value}`)}>{!workspace && <option value="" disabled>Choose a workspace</option>}{manageable.map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}</select></label>}
    {workspace ? <PeopleList key={workspace.slug} workspace={workspace} reloadWorkspaces={reloadWorkspaces} me={me} /> : <Empty title="No workspace to manage">{selected ? "Choose a workspace you administer." : "Only workspace and platform administrators can manage people."}</Empty>}
  </>;
}

function PeopleList({ workspace, reloadWorkspaces, me }: { workspace: Workspace; reloadWorkspaces: () => void; me: Me }) {
  const people = useLoad<{ members: Person[]; invitations: Invitation[] }>(`${workspacePath(workspace.slug)}/people`);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [role, setRole] = useState<Role>("member");
  const [edit, setEdit] = useState<{ person: Person; removing: boolean } | null>(null);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const action = useAction();
  const refresh = () => { people.reload(); reloadWorkspaces(); };
  const invitationAction = (id: string, verb: "resend" | "revoke") => action.run(async () => {
    setNotice("");
    try { await api(`/api/invitations/${id}/${verb}`, { method: "POST", body: {} }); setNotice(verb === "resend" ? "Invitation email sent." : "Invitation revoked."); }
    finally { refresh(); }
  });
  const matches = (person: Person) => person.email.toLowerCase().includes(search.toLowerCase());
  const members = people.data?.members.filter(matches) ?? [];
  const invitations = people.data?.invitations.filter(matches) ?? [];
  const lastAdmin = people.data?.members.filter(person => person.role === "admin").length === 1;
  return <>
    <div className="section-heading people-heading"><div><h2>People in {workspace.name}</h2><p className="muted section-description">Everyone here shares this workspace’s bots, conversations, files, and routines.</p></div><div className="inline-actions"><button aria-label="Refresh people" disabled={people.loading || action.busy} onClick={people.reload}><RefreshCw size={16} />Refresh</button><button className="primary" disabled={workspace.status !== "running" || people.loading || Boolean(people.error)} onClick={() => setInviteOpen(true)}><Plus size={16} />Invite people</button></div></div>
    {!workspace.role && workspace.status === "running" && <p className="footnote"><ShieldCheck size={15} />You have management access only. Invite {me.email} if you also want to join the workspace.</p>}
    {workspace.status !== "running" && <div className="notice">This workspace must be ready before you can invite someone.</div>}
    <ErrorNotice error={people.error} retry={people.reload} /><ErrorNotice error={action.error} />{notice && <div className="notice success" role="status"><Check size={17} />{notice}</div>}
    {people.loading ? <Loading label="Loading people…" /> : people.data && <>
      {(people.data.members.length > 0 || people.data.invitations.length > 0) && <label className="search-field people-search"><Search size={17} /><input aria-label="Search people" type="search" placeholder="Find an email address…" value={search} onChange={event => setSearch(event.target.value)} /></label>}
      <section className="people-section"><h3>Members <span className="count">{people.data.members.length}</span></h3>{members.length ? <div className="table-wrap"><table><thead><tr><th>Email</th><th>Role</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{members.map(person => <tr key={person.email}><td><span className="member-name">{person.email}{person.email === me.email && <span className="table-meta">You</span>}</span></td><td>{roleName(person.role)}</td><td>{person.role === "admin" && lastAdmin ? <span className="table-meta">Last administrator</span> : <div className="row-actions"><button className="small" disabled={action.busy} aria-label={`Change role for ${person.email}`} onClick={() => { setRole(person.role); setEdit({ person, removing: false }); }}>Change role</button><button className="small danger-text" disabled={action.busy} aria-label={`Remove ${person.email}`} onClick={() => setEdit({ person, removing: true })}>Remove</button></div>}</td></tr>)}</tbody></table></div> : <Empty title={search ? "No matching members" : "Bring your team into this workspace"}>{search ? "Try another email address." : "Invite a workspace administrator first, then add as many members as your team needs."}</Empty>}{lastAdmin && <p className="footnote">Keep at least one workspace administrator. Promote another member before removing the last one.</p>}</section>
      <section className="people-section"><h3>Invitations <span className="count">{people.data.invitations.length}</span></h3>{invitations.length ? <div className="table-wrap"><table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{invitations.map(invitation => {
        const pending = invitation.status === "pending" && invitation.expiresAt > Date.now();
        return <tr key={invitation.id}><td>{invitation.email}</td><td>{roleName(invitation.role)}</td><td><Status value={invitation.status === "pending" && !pending ? "expired" : invitation.status} /></td><td className="nowrap">{date(invitation.expiresAt)}</td><td>{pending && <div className="row-actions"><button className="small" disabled={action.busy} aria-label={`Resend invitation to ${invitation.email}`} onClick={() => void invitationAction(invitation.id, "resend")}>Resend</button><button className="small danger-text" disabled={action.busy} aria-label={`Revoke invitation for ${invitation.email}`} onClick={() => void invitationAction(invitation.id, "revoke")}>Revoke</button></div>}</td></tr>;
      })}</tbody></table></div> : <p className="muted inset">{search ? "No matching invitations." : "Invitations will appear here until people accept them."}</p>}</section>
    </>}
    {inviteOpen && <InvitePeople workspace={workspace} firstAdmin={!people.data?.members.some(person => person.role === "admin")} onClose={() => setInviteOpen(false)} refresh={refresh} />}
    {edit && <Modal title={edit.removing ? "Remove member?" : "Change workspace role"} onClose={() => setEdit(null)} busy={action.busy}><p className="muted">{edit.person.email}{edit.removing ? " will lose access to this workspace. Their conversations are not deleted." : ` · ${workspace.name}`}</p><form onSubmit={event => { event.preventDefault(); void action.run(async () => {
      setNotice("");
      try { await api(`${workspacePath(workspace.slug)}/members`, { method: edit.removing ? "DELETE" : "POST", body: { email: edit.person.email, ...(!edit.removing ? { role } : {}) } }); setEdit(null); setNotice(edit.removing ? "Member removed." : "Role updated."); }
      finally { refresh(); }
    }); }}><fieldset disabled={action.busy}>{!edit.removing && <RoleSelect value={role} onChange={setRole} />}<ErrorNotice error={action.error} /><div className="form-footer"><button type="button" onClick={() => setEdit(null)}>Cancel</button><button type="submit" className={edit.removing ? "danger" : "primary"}>{action.busy ? "Saving…" : edit.removing ? "Remove member" : "Save role"}</button></div></fieldset></form></Modal>}
  </>;
}

function InvitePeople({ workspace, firstAdmin, onClose, refresh }: { workspace: Workspace; firstAdmin: boolean; onClose: () => void; refresh: () => void }) {
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<Role>(firstAdmin ? "admin" : "member");
  const [results, setResults] = useState<InvitationResult[]>([]);
  const action = useAction();
  const failed = results.filter(result => !result.sent && !result.uncertain);
  const submit = (retry: boolean) => action.run(async () => {
    const addresses = retry ? failed.map(result => result.email) : invitationEmails(emails);
    try {
      const next = await sendInvitations(addresses, async email => {
        const previous = retry ? results.find(result => result.email === email) : undefined;
        if (previous?.invitationId) {
          try { await api(`/api/invitations/${previous.invitationId}/resend`, { method: "POST", body: {} }); }
          catch (error) { if (error instanceof RequestError) throw new RequestError(error.message, error.status, false, previous.invitationId); throw error; }
        } else await api(`${workspacePath(workspace.slug)}/invitations`, { method: "POST", body: { email, role } });
      });
      setResults(retry ? results.map(result => next.find(item => item.email === result.email) ?? result) : next);
    } finally { refresh(); }
  });
  return <Modal title={`Invite to ${workspace.name}`} onClose={onClose} busy={action.busy}>
    <p className="muted">They’ll receive an email invitation to this shared workspace. Access starts only after they accept.</p>
    {!results.length ? <form onSubmit={event => { event.preventDefault(); void submit(false); }}><fieldset disabled={action.busy}>
      <label>Email addresses<textarea autoFocus required rows={3} maxLength={6420} autoComplete="off" spellCheck={false} value={emails} onChange={event => setEmails(event.target.value)} placeholder={"alex@company.com\nsam@company.com"} aria-describedby="invite-emails-hint" /></label><p className="field-hint" id="invite-emails-hint">One or more addresses, separated by commas or new lines. Up to 20 at a time.</p>
      <RoleSelect value={role} onChange={setRole} />{firstAdmin && <p className="field-hint">This workspace needs its first administrator. You can invite other people as members in the next batch.</p>}
      <ErrorNotice error={action.error} /><div className="form-footer"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary">{action.busy ? "Sending invitations…" : "Send invitations"}</button></div>
    </fieldset></form> : <>
      <div className="notice compact" role="status">{results.filter(result => result.sent).length} of {results.length} invitation emails sent.</div>
      <ul className="invite-results">{results.map(result => <li key={result.email}><div><strong>{result.email}</strong><span className={result.sent ? "saved" : "delivery-error"}>{result.sent ? "Email sent · awaiting acceptance" : result.uncertain ? "Delivery not confirmed. Close this dialog and check the invitation list before sending again." : result.error}</span></div>{result.sent && <Check size={17} aria-label="Sent" />}</li>)}</ul>
      <ErrorNotice error={action.error} /><p className="field-hint">Successful invitations will not be sent again. Saved invitations with failed email delivery are retried using Resend.</p>
      <div className="form-footer">{failed.length > 0 && <button disabled={action.busy} onClick={() => void submit(true)}>{action.busy ? "Retrying…" : `Retry ${failed.length} failed`}</button>}<button className="primary" disabled={action.busy} onClick={onClose}>Done</button></div>
    </>}
  </Modal>;
}

function RoleSelect({ value, onChange }: { value: Role; onChange: (role: Role) => void }) {
  return <label>Role<select value={value} onChange={event => onChange(event.target.value as Role)}><option value="member">Member</option><option value="admin">Workspace admin</option></select><span className="field-hint">Members use the workspace. Workspace admins also manage its people and settings.</span></label>;
}

function Providers() {
  const provider = useLoad<ProvidersResponse>("/api/providers");
  return <><header className="page-header"><div><p className="eyebrow">Platform settings</p><h1>Providers</h1><p className="muted">Save provider keys once, then assign models to each workspace.</p></div></header><ErrorNotice error={provider.error} retry={provider.reload} />{provider.loading ? <Loading /> : <div className="provider-list">{provider.data?.providers.map(item => <ProviderForm key={item.id} provider={item} />)}</div>}</>;
}

function ProviderForm({ provider }: { provider: Provider }) {
  const [key, setKey] = useState("");
  const [models, setModels] = useState(provider.models.join("\n"));
  const [configured, setConfigured] = useState(provider.configured);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const hintId = useId();
  const name = providerName(provider.id);
  return <section className="panel provider-panel" aria-label={name}><div className="section-heading"><span className="provider-mark" aria-hidden="true">{provider.id === "openrouter" ? "OR" : "A"}</span><h2>{name}</h2><span className={`status ${configured ? "status-running" : "status-suspended"}`}>{configured ? "Key saved" : "Not configured"}</span></div>
    <p className="muted">Workspaces use a managed connection. The platform key is never shown to workspace members.</p>
    <form onSubmit={event => { event.preventDefault(); setSaved(false); void action.run(async () => {
      const result = await api<Provider>(`/api/providers/${provider.id}`, { method: "POST", body: { ...(key.trim() ? { key: key.trim() } : {}), models: [...new Set(models.split(/\n|,/).map(value => value.trim()).filter(Boolean))] } });
      setKey(""); setModels(result.models.join("\n")); setConfigured(result.configured); setSaved(true);
    }); }}><fieldset disabled={action.busy}>
      <label>{configured ? "Replace API key" : "API key"}<input type="password" autoComplete="new-password" spellCheck={false} required={!configured} maxLength={1024} value={key} onChange={event => { setKey(event.target.value); setSaved(false); }} placeholder={configured ? "Leave blank to keep the current key" : provider.id === "openrouter" ? "sk-or-v1-…" : "sk-ant-…"} /></label>
      <label>Allowed model IDs<textarea rows={5} required={false} value={models} onChange={event => { setModels(event.target.value); setSaved(false); }} placeholder={`Enter one ${name} model ID per line`} aria-describedby={hintId} /></label><p className="field-hint" id={hintId}>Use exact provider model IDs, one per line. Each workspace receives only the models you assign to it. Removing a model stops its managed use across all workspaces.</p>
      <ErrorNotice error={action.error} /><div className="inline-actions"><button className="primary" type="submit">{action.busy ? "Saving…" : "Save provider"}</button>{saved && <span className="saved" role="status"><Check size={16} />Provider saved</span>}</div>
    </fieldset></form><p className="footnote">{provider.id === "openrouter" ? "Uses OpenCode on the workspace server. Choose tool-capable chat models; automatic routers, presets and model fallbacks are not supported. Saving a key does not make a paid test call." : "Personal CLI subscriptions are not pooled or connected here."}</p>
  </section>;
}

const activityLabels: Record<string, string> = {
  "provider.access.restricted": "Model restrictions applied",
  "workspace.create.started": "Workspace setup started", "workspace.create.completed": "Workspace created", "workspace.create.failed": "Workspace setup failed",
  "workspace.suspend": "Workspace suspended", "workspace.resume": "Workspace resumed", "workspace.removed.data-retained": "Workspace removed · data retained",
  "invitation.created": "Invitation created", "invitation.accepted": "Invitation accepted", "invitation.revoked": "Invitation revoked", "invitation.resent": "Invitation resent",
  "member.removed": "Member removed", "member.role.changed": "Member role changed", "provider.access.changed": "Model access changed", "provider.updated": "Provider updated",
};

function ActivityPage() {
  const activity = useLoad<{ activity: Activity[] }>("/api/activity");
  return <><header className="page-header"><div><p className="eyebrow">Platform record</p><h1>Activity</h1><p className="muted">Recent workspace, access and provider changes.</p></div><button onClick={activity.reload} disabled={activity.loading}><RefreshCw size={16} />Refresh</button></header><ErrorNotice error={activity.error} retry={activity.reload} />{activity.loading ? <Loading /> : activity.data?.activity.length ? <div className="table-wrap"><table><thead><tr><th>Action</th><th>Workspace</th><th>Changed by</th><th>When</th></tr></thead><tbody>{activity.data.activity.map(item => <tr key={item.id}><td>{activityLabels[item.action] ?? item.action}{item.detail && <span className="table-meta">{item.detail}</span>}</td><td>{item.workspace ?? "Platform"}</td><td>{item.actor}</td><td className="nowrap">{date(item.at)}<span className="table-meta">{new Date(item.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span></td></tr>)}</tbody></table></div> : <Empty title="No activity yet">Changes made in this portal will appear here.</Empty>}</>;
}

function InvitationPage({ id, me, switchAccount, navigate }: { id: string; me: Me; switchAccount: () => void; navigate: (path: string) => void }) {
  const invitation = useLoad<{ invitation: Invitation; workspace: { name: string; slug: string } }>(`/api/invitations/${id}`);
  const action = useAction();
  const data = invitation.data;
  const pending = data?.invitation.status === "pending" && data.invitation.expiresAt > Date.now();
  return <div className="focused-panel"><p className="eyebrow">Workspace invitation</p><h1>{data ? `Join ${data.workspace.name}` : "Your invitation"}</h1><p className="muted">Signed in as <strong>{me.email}</strong></p>
    {invitation.loading ? <Loading label="Checking invitation…" /> : invitation.error instanceof RequestError && invitation.error.wrongAccount ? <><div className="notice error" role="alert">This invitation belongs to a different email address. Switch accounts to sign in with the invited email.</div><button className="primary" onClick={switchAccount}><LogOut size={17} />Switch account</button></> : <>
      <ErrorNotice error={invitation.error} retry={invitation.reload} />{data && <>
        <div className="invitation-details"><span>Workspace</span><strong>{data.workspace.name}</strong><span>Your role</span><strong>{roleName(data.invitation.role)}</strong><span>Invitation</span><Status value={data.invitation.status === "pending" && !pending ? "expired" : data.invitation.status} /></div>
        <p className="muted">{pending ? "You’ll share this workspace’s bots, conversations, files, and routines with its other members. Your email account and personal AI subscriptions will not be connected to a bot." : "This invitation is no longer pending. Open your workspaces if you already joined, or ask your administrator for a new invitation."}</p>
        <ErrorNotice error={action.error} /><div className="inline-actions">{pending ? <button className="primary" disabled={action.busy} onClick={() => void action.run(async () => { const result = await api<{ url: string }>(`/api/invitations/${id}/accept`, { method: "POST", body: {} }); window.location.assign(result.url); })}>{action.busy ? "Accepting…" : "Accept invitation"}<ArrowUpRight size={16} /></button> : <button onClick={() => navigate("/workspaces")}>View workspaces</button>}<button disabled={action.busy} onClick={switchAccount}>Switch account</button></div>
      </>}
    </>}
  </div>;
}

function ConnectPage({ workspace, params, me, switchAccount }: { workspace?: Workspace; params: URLSearchParams; me: Me; switchAccount: () => void }) {
  const action = useAction();
  const state = params.get("state") ?? "";
  const challenge = params.get("challenge") ?? "";
  const valid = /^[A-Za-z0-9_-]{43}$/.test(state) && /^[A-Za-z0-9_-]{43}$/.test(challenge);
  return <div className="focused-panel"><p className="eyebrow">Workspace sign-in</p><h1>{workspace ? `Open ${workspace.name}?` : "Workspace unavailable"}</h1><p className="muted">Signed in as <strong>{me.email}</strong></p>
    {!workspace || !workspace.role ? <div className="notice error">This account does not have access to this workspace. Accept its invitation first, or switch to an account that has access.</div> : !valid ? <div className="notice error">This sign-in link is incomplete. Open the workspace again to start a new sign-in.</div> : workspace.status !== "running" ? <div className="notice">This workspace is not ready. Ask its administrator to check its status.</div> : <>
      <div className="connection-destination"><Layers3 size={23} /><div><strong>{workspace.name}</strong><span>{workspace.host}</span></div></div>
      <p className="muted">Continue to sign in to this workspace as {roleName(workspace.role).toLowerCase()}.</p><ErrorNotice error={action.error} />
      <button className="primary" disabled={action.busy} onClick={() => void action.run(async () => { const result = await api<{ url: string }>(`${workspacePath(workspace.slug)}/connect`, { method: "POST", body: { state, challenge } }); window.location.assign(result.url); })}>{action.busy ? "Connecting…" : "Continue to workspace"}<ArrowUpRight size={16} /></button>
    </>}
    <button className="text-button switch-account" disabled={action.busy} onClick={switchAccount}>Switch account</button>
  </div>;
}

export function App() {
  const config = useLoad<PublicConfig>("/api/public/config");
  const identity = useLoad<Me>("/api/me");
  const [route, setRoute] = useState(routeNow);
  const action = useAction();
  useEffect(() => { const changed = () => setRoute(routeNow()); window.addEventListener("popstate", changed); return () => window.removeEventListener("popstate", changed); }, []);
  useEffect(() => { if (config.data) document.title = `${config.data.name} Admin`; }, [config.data]);
  const navigate = (path: string) => { window.history.pushState(null, "", path); setRoute(path); window.scrollTo(0, 0); };
  const me = identity.data;
  const workspaces = useLoad<{ workspaces: Workspace[] }>(me ? "/api/workspaces" : null);
  const switchAccount = () => void action.run(async () => { const result = await auth.signOut(); if (result.error) throw new Error(result.error.message ?? "Sign-out failed."); identity.reload(); });
  const page = new URL(route, window.location.origin);
  const invitationId = /^\/invite\/([\w-]+)$/.exec(page.pathname)?.[1];
  const selected = /^\/workspaces\/([a-z0-9-]+)$/.exec(page.pathname)?.[1];
  const section = page.pathname.split("/")[1] || "workspaces";
  const list = workspaces.data?.workspaces ?? [];
  const workspace = list.find(item => item.slug === selected);
  if (config.loading || identity.loading) return <main className="auth-page"><Loading label="Opening your portal…" /></main>;
  if (config.error || !config.data) return <main className="auth-page"><div className="auth-card"><h1>Portal unavailable</h1><ErrorNotice error={config.error} retry={config.reload} /></div></main>;
  if (!me) {
    if (identity.error && !(identity.error instanceof RequestError && identity.error.status === 401)) return <main className="auth-page"><div className="auth-card"><Brand name={config.data.name} /><ErrorNotice error={identity.error} retry={identity.reload} /></div></main>;
    return <Login config={config.data} onSignedIn={identity.reload} />;
  }
  const managesPeople = me.platformAdmin || list.some(workspace => workspace.role === "admin");
  const nav = [{ id: "workspaces", label: "Workspaces", icon: Layers3 }, ...(managesPeople ? [{ id: "people", label: "People", icon: Users }] : []), ...(me.platformAdmin ? [{ id: "providers", label: "Providers", icon: KeyRound }, { id: "activity", label: "Activity", icon: Clock3 }] : [])];
  return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to content</a><aside className="sidebar"><Brand name={config.data.name} /><nav aria-label="Main navigation">{nav.map(item => <a key={item.id} href={`/${item.id}`} aria-current={section === item.id ? "page" : undefined} onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate(`/${item.id}`); } }}><item.icon size={18} strokeWidth={1.7} />{item.label}</a>)}</nav><div className="account"><span className="account-avatar" aria-hidden="true">{(me.name || me.email).slice(0, 1).toUpperCase()}</span><div><strong>{me.platformAdmin ? "Platform administrator" : "Your account"}</strong><span title={me.email}>{me.email}</span></div><button className="icon-button" aria-label="Sign out" title="Sign out" disabled={action.busy} onClick={switchAccount}><LogOut size={17} /></button></div></aside>
    <main id="main-content" className="main-content"><ErrorNotice error={action.error} />{invitationId ? <InvitationPage key={invitationId} id={invitationId} me={me} switchAccount={switchAccount} navigate={navigate} /> : section === "providers" ? me.platformAdmin ? <Providers /> : <Empty title="Platform administrator access required" /> : section === "activity" ? me.platformAdmin ? <ActivityPage /> : <Empty title="Platform administrator access required" /> : workspaces.loading && (!workspaces.data || (selected && !workspace)) ? <Loading label="Loading workspaces…" /> : workspaces.error ? <ErrorNotice error={workspaces.error} retry={workspaces.reload} /> : section === "connect" ? <ConnectPage workspace={list.find(item => item.slug === page.searchParams.get("workspace"))} params={page.searchParams} me={me} switchAccount={switchAccount} /> : section === "people" ? <People me={me} workspaces={list} selected={page.searchParams.get("workspace")} navigate={navigate} reloadWorkspaces={workspaces.reload} /> : selected ? workspace ? <WorkspaceDetail key={workspace.slug} workspace={workspace} me={me} navigate={navigate} reload={workspaces.reload} loading={workspaces.loading} selectedTab={page.searchParams.get("tab")} created={page.searchParams.get("created") === "1"} /> : <Empty title="Workspace not found"><button onClick={() => navigate("/workspaces")}>Back to workspaces</button></Empty> : <Workspaces me={me} workspaces={list} navigate={navigate} reload={workspaces.reload} loading={workspaces.loading} />}</main>
  </div>;
}
