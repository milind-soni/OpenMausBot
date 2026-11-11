"use client";
import { errorText } from "@/lib/error-text";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useAction, useMutation, useQueries, useQuery } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { flushSync } from "react-dom";
import { ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { WorkspaceContext } from "./workspace-context";
import { WorkspaceSkeleton } from "./content-skeleton";
import { lazyComponent } from "./lazy-component";
import { authFieldError, authFieldForServerError, authFormErrors, type AuthField, type AuthValues } from "@/lib/auth-form";

const OriginWorkspace = lazyComponent(() => import("./origin-app").then(module => module.OriginWorkspace), <WorkspaceSkeleton />);

// A stored session means the workspace is next: fetch its code while the session and workspaces load.
if (typeof window !== "undefined") {
  try { if (localStorage.getItem("origin.sessionToken")) void OriginWorkspace.preload().catch(() => undefined); } catch { /* Storage blocked: nothing to prefetch for. */ }
}

/** Signed-out paths render nothing until the stored session is read, instead of flashing the workspace skeleton. */
const publicPath = (path: string) => path === "/" || path === "/login" || path === "/signup" || path.startsWith("/join/");
/** A deleted workspace is worth mentioning on the empty screen for a week; the backend keeps notices longer. */
const RECENT_DELETION = 7 * 86_400_000;

export function OriginEntry() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const path = usePathname();
  const router = useRouter();
  const user = useQuery(api.auth.me, token ? { sessionToken: token } : "skip");
  // Workspaces load alongside the session check; an expired session's error is dropped (it shows sign-in instead).
  const listed = useQueries(useMemo((): Parameters<typeof useQueries>[0] => token ? { list: { query: api.workspaces.list, args: { sessionToken: token } } } : {}, [token])).list as FunctionReturnType<typeof api.workspaces.list> | Error | undefined;
  if (user && listed instanceof Error) throw listed;
  const workspaces = user && !(listed instanceof Error) ? listed : undefined;
  const ensureLegacy = useMutation(api.workspaces.ensureLegacyWorkspace);
  const acceptInvite = useMutation(api.workspaces.acceptInvite);
  const logout = useMutation(api.auth.logout);
  const inviteToken = path.startsWith("/join/") ? path.split("/")[2] : undefined;
  const invitation = useQuery(api.workspaces.invitePreview, inviteToken ? { token: inviteToken } : "skip");
  const slug = path.split("/")[1];
  const workspace = workspaces?.find(w => w.slug === slug);
  // `/issue/ORI-1A2B` has no workspace in it: open it in the workspace this browser last used.
  const issueWithoutWorkspace = slug === "issue" && !workspaces?.some(w => w.slug === "issue");
  const redirecting = !inviteToken && (["", "login", "signup"].includes(slug) || issueWithoutWorkspace) && Boolean(workspaces?.length);
  useEffect(() => { setToken(localStorage.getItem("origin.sessionToken")); setReady(true); }, []);
  useEffect(() => {
    if (token && user) void ensureLegacy({ sessionToken: token }).catch(error => setNotice(errorText(error, "Could not open your workspace")));
  }, [token, user?._id, ensureLegacy]);
  useEffect(() => {
    if (!token || !user || !workspaces?.length || !redirecting) return;
    const preferred = workspaces.find(w => w.slug === localStorage.getItem("origin.workspace")) || workspaces[0];
    router.replace(issueWithoutWorkspace ? `/${preferred.slug}${path}` : `/${preferred.slug}`);
  }, [token, user, workspaces, redirecting, router, issueWithoutWorkspace, path]);
  const saveSession = async (sessionToken: string, destination?: string | null) => {
    localStorage.setItem("origin.sessionToken", sessionToken);
    // Signing in or up from an invitation link joins right away instead of asking again.
    if (inviteToken) {
      try { const result = await acceptInvite({ sessionToken, token: inviteToken }); setToken(sessionToken); router.replace(`/${result.slug}`); return; }
      catch (error) { setNotice(errorText(error, "Could not join")); }
    }
    setToken(sessionToken);
    if (!inviteToken && destination) router.replace(`/${destination}`);
  };
  /** Ends the session here first so the screen changes at once; `to` keeps an invitation link open for another account. */
  const signOut = async (to = "/login") => {
    if (!token) return;
    localStorage.removeItem("origin.sessionToken");
    flushSync(() => setToken(null));
    router.replace(to);
    await logout({ sessionToken: token }).catch(() => { /* The session is gone locally either way. */ });
  };
  if (!ready || (token && user === undefined)) return publicPath(path) ? <main className="public-auth" aria-busy="true" /> : <WorkspaceSkeleton />;
  if (!user || !token) {
    if (path === "/") return <Welcome />;
    return <PublicAuth key={inviteToken ?? "auth"} signup={path === "/signup" || Boolean(inviteToken)} inviteToken={inviteToken} invitation={invitation} onSession={saveSession} />;
  }
  if (inviteToken) return <AuthFrame>
    <h1>{invitation ? `Join ${invitation.name}` : invitation === undefined ? "Loading invitation" : "Invitation unavailable"}</h1>
    {invitation === null && <p>This link has expired or was revoked.</p>}
    {notice && <p className="notice danger" role="alert">{notice}</p>}
    {invitation && <JoinButton name={invitation.name} onJoin={async () => { try { const result = await acceptInvite({ sessionToken: token, token: inviteToken }); router.replace(`/${result.slug}`); } catch (error) { setNotice(errorText(error, "Could not join")); } }} />}
    {invitation === null && <Link className="primary-button large" href="/">Open Origin</Link>}
    <SignedInAs email={user.email} onSignOut={() => void signOut(path)} />
  </AuthFrame>;
  if (workspaces === undefined || redirecting) return <WorkspaceSkeleton />;
  if (!workspaces.length) return <WorkspaceOnboarding sessionToken={token} email={user.email} onSignOut={() => void signOut()} onCreated={s => router.replace(`/${s}`)} />;
  if (!workspace) return <AuthFrame>
    <h1>Workspace not found</h1>
    <nav className="workspace-choices" aria-label="Your workspaces">{workspaces.map(w => <Link className="workspace-choice" href={`/${w.slug}`} key={w._id}><span className="workspace-initial" aria-hidden="true">{w.name.slice(0, 1).toUpperCase()}</span><span>{w.name}</span><ArrowRight size={16} /></Link>)}</nav>
    {notice && <p className="notice danger">{notice}</p>}
    <SignedInAs email={user.email} onSignOut={() => void signOut()} />
  </AuthFrame>;
  return <WorkspaceContext.Provider value={workspace}><OriginWorkspace key={workspace._id} sessionToken={token} user={user} workspaces={workspaces} onLogout={() => void signOut()} /></WorkspaceContext.Provider>;
}

function AuthFrame({ children }: { children: ReactNode }) {
  return <main className="public-auth"><Link className="origin-wordmark" href="/"><OriginMark />Origin</Link><section className="auth-content">{children}</section></main>;
}

function SignedInAs({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return <p className="auth-switch">{email} <button type="button" onClick={onSignOut}>Sign out</button></p>;
}

function PublicAuth({ signup: initialSignup, inviteToken, invitation, onSession }: { signup: boolean; inviteToken?: string; invitation?: { name: string; role: string; email?: string } | null; onSession: (token: string, slug?: string | null) => Promise<void> }) {
  const [signup, setSignup] = useState(initialSignup);
  const [values, setValues] = useState<AuthValues>({ name: "", email: "", password: "", workspaceName: "", slug: "" });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<AuthField, string>>>({});
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [host, setHost] = useState("");
  const login = useAction(api.auth.login);
  const register = useAction(api.auth.signup);
  const mode = useQuery(api.auth.signupMode, {});
  const inviteOnly = Boolean(mode?.inviteOnly) && !inviteToken;
  const fields: AuthField[] = signup ? ["name", "email", "password", ...(inviteToken ? [] : ["workspaceName", "slug"] as const)] : ["email", "password"];
  useEffect(() => setHost(window.location.host), []);
  useEffect(() => { if (invitation?.email) setValues(current => ({ ...current, email: invitation.email! })); }, [invitation?.email]);
  // The address follows the form, so a reload or a shared link opens the same screen.
  const switchMode = () => {
    const next = !signup;
    setSignup(next); setError(""); setFieldErrors({}); setVisible(false);
    if (!inviteToken) window.history.replaceState(null, "", next ? "/signup" : "/login");
  };
  const focusField = (field: AuthField) => document.getElementById(`auth-${field}`)?.focus();
  // A shown message follows the typing and goes away once the field is right; new ones wait for blur or submit.
  const change = (patch: Partial<AuthValues>) => {
    const next = { ...values, ...patch };
    setValues(next);
    setFieldErrors(current => {
      const updated = { ...current };
      for (const field of Object.keys(patch) as AuthField[]) if (updated[field]) updated[field] = authFieldError(field, next, signup) || undefined;
      return updated;
    });
  };
  const blur = (field: AuthField) => {
    if (!values[field]) return;
    const message = authFieldError(field, values, signup);
    setFieldErrors(current => current[field] === (message || undefined) ? current : { ...current, [field]: message || undefined });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const errors = authFormErrors(fields, values, signup);
    setFieldErrors(errors); setError("");
    const first = fields.find(field => errors[field]);
    if (first) { focusField(first); return; }
    setBusy(true);
    try {
      const { name, email, password, workspaceName, slug } = values;
      if (signup) { const result = await register({ email, password, name, ...(inviteToken ? { inviteToken } : { workspaceName, slug }) }); await onSession(result.sessionToken, result.slug); }
      else { const result = await login({ email, password }); await onSession(result.sessionToken); }
    } catch (error) {
      const message = errorText(error, "Please try again");
      const field = authFieldForServerError(message);
      if (field && fields.includes(field)) { setFieldErrors({ [field]: message }); focusField(field); }
      else setError(message);
    }
    finally { setBusy(false); }
  };
  const field = (name: AuthField) => ({
    id: `auth-${name}`,
    "aria-invalid": fieldErrors[name] ? true : undefined,
    "aria-describedby": fieldErrors[name] ? `auth-${name}-error` : undefined,
    onBlur: () => blur(name),
  });
  const message = (name: AuthField) => fieldErrors[name] ? <p id={`auth-${name}-error`} className="auth-field-error">{fieldErrors[name]}</p> : null;
  if (inviteToken && invitation === null) return <AuthFrame>
    <h1>Invitation unavailable</h1>
    <p>This link has expired or was revoked.</p>
    <Link className="primary-button large" href="/login">Sign in</Link>
  </AuthFrame>;
  return <AuthFrame>
    <h1>{invitation ? `Join ${invitation.name}` : inviteToken ? "Join workspace" : signup ? "Create account" : "Sign in"}</h1>
    {signup && inviteOnly ? <p className="notice">Sign-up is invite-only. Ask a workspace admin for an invitation link.</p> : <form className="stack-form" onSubmit={submit} noValidate>
      {signup && <div className="form-field"><label>Your name<input {...field("name")} autoComplete="name" value={values.name} onChange={e => change({ name: e.target.value })} maxLength={100} autoFocus /></label>{message("name")}</div>}
      <div className="form-field"><label>Email<input {...field("email")} autoComplete="email" type="email" inputMode="email" autoCapitalize="none" spellCheck={false} value={values.email} onChange={e => change({ email: e.target.value })} maxLength={254} autoFocus={!signup} /></label>{message("email")}</div>
      <div className="form-field"><label>Password<span className="password-input"><input {...field("password")} autoComplete={signup ? "new-password" : "current-password"} type={visible ? "text" : "password"} value={values.password} onChange={e => change({ password: e.target.value })} maxLength={128} placeholder={signup ? "At least 10 characters" : undefined} /><button type="button" aria-label={visible ? "Hide password" : "Show password"} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></label>{message("password")}</div>
      {signup && !inviteToken && <>
        <div className="form-field"><label>Workspace name<input {...field("workspaceName")} value={values.workspaceName} onChange={e => change({ workspaceName: e.target.value, slug: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) })} maxLength={60} /></label>{message("workspaceName")}</div>
        <div className="form-field"><label>Workspace URL<span className="slug-input" data-invalid={fieldErrors.slug ? true : undefined}><span>{host}/</span><input {...field("slug")} value={values.slug} onChange={e => change({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} maxLength={48} autoCapitalize="none" spellCheck={false} /></span></label>{message("slug")}</div>
      </>}
      {error && <p role="alert" className="notice danger">{error}</p>}
      <button type="submit" className="primary-button large" disabled={busy}>{busy ? <Loader2 className="spin" size={16} /> : signup ? "Create account" : "Sign in"}</button>
    </form>}{(signup || !inviteOnly) && <p className="auth-switch">{signup ? "Have an account?" : "No account?"} <button type="button" onClick={switchMode}>{signup ? "Sign in" : "Create an account"}</button></p>}
  </AuthFrame>;
}

function JoinButton({ name, onJoin }: { name: string; onJoin: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <button className="primary-button large" disabled={busy} onClick={async () => { setBusy(true); try { await onJoin(); } finally { setBusy(false); } }}>{busy && <Loader2 className="spin" size={16} />}Join {name}</button>;
}

function OriginMark() {
  return <svg className="origin-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="12" cy="12" r="3.75" fill="currentColor" /></svg>;
}

function Welcome() {
  return <main className="public-auth welcome"><section className="auth-content"><span className="origin-wordmark"><OriginMark />Origin</span><div className="welcome-actions"><Link className="primary-button large" href="/login">Sign in</Link><Link className="ghost-button large" href="/signup">Create account</Link></div></section></main>;
}

function WorkspaceOnboarding({ sessionToken, email, onSignOut, onCreated }: { sessionToken: string; email: string; onSignOut: () => void; onCreated: (slug: string) => void }) {
  const create = useMutation(api.workspaces.create);
  const deleted = useQuery(api.workspaces.deleted, { sessionToken });
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Read once on mount: the notice is about why this screen is empty, not a live clock.
  const [shownSince] = useState(() => Date.now() - RECENT_DELETION);
  const recent = deleted?.find(notice => !notice.byYou && notice.deletedAt > shownSince);
  return <AuthFrame>
    <h1>Create a workspace</h1>
    {recent && <p className="notice">{recent.name} was deleted by {recent.deletedBy}.</p>}
    <form className="stack-form" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { const result = await create({ sessionToken, name }); onCreated(result.slug); } catch (error) { setError(errorText(error, "Could not create workspace")); setBusy(false); } }}>
      <label>Workspace name<input value={name} onChange={e => setName(e.target.value)} required maxLength={60} autoFocus /></label>
      {error && <p className="notice danger" role="alert">{error}</p>}
      <button className="primary-button large" disabled={busy || !name.trim()}>{busy ? <Loader2 className="spin" size={16} /> : "Create workspace"}</button>
    </form>
    <SignedInAs email={email} onSignOut={onSignOut} />
  </AuthFrame>;
}
