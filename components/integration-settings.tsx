"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { ExternalLink, GitBranch, Loader2, Unplug } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useWorkspace } from "./workspace-context";
import { localApi, localAppOrigin, navigateLocalApp } from "@/lib/client-api";
import { errorText } from "@/lib/error-text";
import { ConfirmButton, SettingSwitch } from "./settings-controls";

type Config = { configured: boolean; canSetup: boolean; login: string | null; installationUrl: string | null; permissionApprovalUrl?: string };

/**
 * GitHub for the workspace, in the states it can actually be in: the instance has no App yet (an owner or admin
 * registers it), the App exists but this workspace is not connected, or it is connected.
 */
export function IntegrationSettings({ sessionToken }: { sessionToken: string }) {
  const workspace = useWorkspace();
  const [config, setConfig] = useState<Config | null>(null), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const github = useQuery(api.integrations.status, { sessionToken, teamId: workspace._id });
  const configure = useMutation(api.integrations.configure);
  const admin = ["owner", "admin"].includes(workspace.role);
  const reload = () => localApi<Config>(`/api/github/workspace?teamId=${workspace._id}`, sessionToken).then(setConfig);
  useEffect(() => { void reload().catch(() => setNotice("Could not load the GitHub connection")); }, [sessionToken, workspace._id]); // eslint-disable-line react-hooks/exhaustive-deps
  const attempt = async (fn: () => Promise<void>) => { setBusy(true); setNotice(""); try { await fn(); } catch (e) { setNotice(errorText(e, "Could not update the connection")); } finally { setBusy(false); } };
  const connect = () => attempt(async () => { const result = await localApi<{ url: string }>(`/api/github/oauth/start?teamId=${workspace._id}`, sessionToken, { method: "POST" }); navigateLocalApp(result.url); });
  const setup = () => attempt(async () => {
    const result = await localApi<{ action: string; manifest: unknown }>(`/api/github/setup?teamId=${workspace._id}`, sessionToken, { method: "POST" });
    const form = document.createElement("form"); form.method = "POST"; form.action = result.action;
    if (localAppOrigin() !== window.location.origin) { form.target = "_blank"; form.rel = "noopener noreferrer"; }
    const field = document.createElement("input"); field.type = "hidden"; field.name = "manifest"; field.value = JSON.stringify(result.manifest);
    form.append(field); document.body.append(form); form.submit(); form.remove();
  });
  const disconnect = () => attempt(async () => { await localApi(`/api/github/workspace?teamId=${workspace._id}`, sessionToken, { method: "DELETE" }); await reload(); });

  const login = github?.login ?? null;
  let title = "GitHub", detail = "", actions: ReactNode = null;
  if (config && !config.configured) {
    title = "Not set up";
    detail = config.canSetup ? "Registers Origin's GitHub App for this server. GitHub asks you to confirm."
      : admin ? "Only the accounts in ORIGIN_ADMIN_EMAILS can register the GitHub App on this server."
      : "A workspace owner or admin sets up GitHub.";
    if (config.canSetup) actions = <button className="primary-button compact" disabled={busy} onClick={() => void setup()}>Set up GitHub</button>;
  } else if (config && !login) {
    title = "Not connected";
    detail = admin ? "Connect the GitHub account or organization that owns your repositories." : "A workspace owner or admin connects GitHub.";
    if (admin) actions = <button className="primary-button compact" disabled={busy} onClick={() => void connect()}>Connect GitHub</button>;
  } else if (config && login) {
    title = `@${login}`;
    detail = "Connected";
    if (admin) actions = <>
      <button className="ghost-button compact" disabled={busy} onClick={() => void connect()}>Reconnect</button>
      <ConfirmButton className="ghost-button compact" label="Disconnect GitHub" confirmLabel="Disconnect" disabled={busy} text="Disconnect" icon={<Unplug size={14} />} onConfirm={() => void disconnect()} />
    </>;
  }

  return <div className="integrations-settings">
    <section className="settings-group">
      <h4>GitHub</h4>
      <div className="settings-list">
        <div className="settings-list-row integration-row">
          <span className="settings-row-icon"><GitBranch size={15} /></span>
          <div><strong>{config ? title : "GitHub"}</strong>{detail && <small>{detail}</small>}</div>
          {(busy || !config) && <Loader2 size={14} className="spin" aria-label="Loading" />}
          {actions && <div className="integration-actions">{actions}</div>}
        </div>
      </div>
      {login && <SettingSwitch label="Create a private repository for new projects" disabled={!admin || busy} checked={Boolean(github?.autoCreate)} onChange={checked => void attempt(async () => { await configure({ sessionToken, teamId: workspace._id, autoCreate: checked }); })} />}
      {login && <p className="settings-note">A pull request links to an issue when its branch or title contains the issue key (ORI-AB12) or its description says “Closes ORI-AB12”. Merging it completes the issue.</p>}
      {admin && config?.configured && <div className="integration-links">
        {config.installationUrl && <a href={config.installationUrl} target="_blank" rel="noreferrer">Repository access<ExternalLink size={12} /></a>}
        {config.permissionApprovalUrl && <a href={config.permissionApprovalUrl} target="_blank" rel="noreferrer">App permissions<ExternalLink size={12} /></a>}
      </div>}
    </section>
    {notice && <p className="notice danger" role="alert">{notice}</p>}
  </div>;
}
