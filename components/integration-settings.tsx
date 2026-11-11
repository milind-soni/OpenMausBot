"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ExternalLink, GitBranch, Loader2, Unplug } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useWorkspace } from "./workspace-context";
import { localApi, localAppOrigin, navigateLocalApp } from "@/lib/client-api";
import { errorText } from "@/lib/error-text";
import { ConfirmButton, SettingSwitch } from "./settings-controls";

type Config = { configured: boolean; canSetup: boolean; login: string | null; installationUrl: string | null; prPermissionNotice?: string; permissionApprovalUrl?: string };
export function IntegrationSettings({ sessionToken }: { sessionToken: string }) {
  const workspace = useWorkspace();
  const [config, setConfig] = useState<Config | null>(null), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const github = useQuery(api.integrations.status, { sessionToken, teamId: workspace._id });
  const configure = useMutation(api.integrations.configure);
  const admin = ["owner", "admin"].includes(workspace.role);
  const reload = () => localApi<Config>(`/api/github/workspace?teamId=${workspace._id}`, sessionToken).then(setConfig);
  useEffect(() => { void reload().catch(() => setNotice("Could not load GitHub connection")); }, [sessionToken, workspace._id]);
  const attempt = async (fn: () => Promise<void>) => { setBusy(true); setNotice(""); try { await fn(); } catch (e) { setNotice(errorText(e, "Could not update connection")); } finally { setBusy(false); } };
  const connect = () => attempt(async () => { const result = await localApi<{ url: string }>(`/api/github/oauth/start?teamId=${workspace._id}`, sessionToken, { method: "POST" }); navigateLocalApp(result.url); });
  const setup = () => attempt(async () => {
    const result = await localApi<{ action: string; manifest: unknown }>(`/api/github/setup?teamId=${workspace._id}`, sessionToken, { method: "POST" });
    const form = document.createElement("form"); form.method = "POST"; form.action = result.action;
    if (localAppOrigin() !== window.location.origin) { form.target = "_blank"; form.rel = "noopener noreferrer"; }
    const field = document.createElement("input"); field.type = "hidden"; field.name = "manifest"; field.value = JSON.stringify(result.manifest);
    form.append(field); document.body.append(form); form.submit(); form.remove();
  });
  return <div className="integrations-settings">
    <section className="integration-section"><div className="integration-heading"><GitBranch size={20} /><div><strong>GitHub</strong><span>{github?.login ? `Connected as @${github.login}` : "Not connected"}</span></div>{busy && <Loader2 size={15} className="spin" />}</div>
      {admin && config && <div className="integration-actions">{config.configured ? <button className="primary-button compact" disabled={busy} onClick={connect}><GitBranch size={14} />{github?.login ? "Reconnect" : "Connect GitHub"}</button> : config.canSetup ? <button className="primary-button compact" disabled={busy} onClick={setup}><GitBranch size={14} />Set up Origin GitHub App</button> : <p className="muted">GitHub is not available yet.</p>}
      {github?.login && <ConfirmButton className="ghost-button compact" label="Disconnect" confirmLabel="Disconnect GitHub" disabled={busy} text="Disconnect" icon={<Unplug size={14} />} onConfirm={() => void attempt(async () => { await localApi(`/api/github/workspace?teamId=${workspace._id}`, sessionToken, { method: "DELETE" }); await reload(); })} />}
      {config.installationUrl && <a className="ghost-button compact" href={config.installationUrl} target="_blank" rel="noreferrer">Repository access<ExternalLink size={13} /></a>}</div>}
      {github?.login && <SettingSwitch label="Create a private repository for new projects" disabled={!admin || busy} checked={Boolean(github?.autoCreate)} onChange={checked => attempt(async () => { await configure({ sessionToken, teamId: workspace._id, autoCreate: checked }); })} />}
      {admin && config?.prPermissionNotice && <div className="notice" role="status"><p>{config.prPermissionNotice}</p><a className="ghost-button compact" href={config.permissionApprovalUrl} target="_blank" rel="noreferrer">Re-approve permissions<ExternalLink size={13} /></a></div>}
    </section>
    {notice && <p className="notice danger" role="alert">{notice}</p>}
  </div>;
}
