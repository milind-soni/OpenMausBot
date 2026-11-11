"use client";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { Bot, KeyRound, Loader2, Plug, Trash2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useWorkspace } from "./workspace-context";
import { localAppOrigin } from "@/lib/client-api";
import { errorText } from "@/lib/error-text";
import { formatDate } from "@/lib/format";
import { ConfirmButton } from "./settings-controls";
import { MCP_TOOLS } from "@/lib/mcp-tools";
import { ClientSetup, CopyButton } from "./agent-clients";
import { AgentMark } from "./issue-agent";

export function AgentSettings({ sessionToken }: { sessionToken: string }) {
  const workspace = useWorkspace();
  const grants = useQuery(api.connectors.listGrants, { sessionToken, teamId: workspace._id });
  const createToken = useMutation(api.mcp.createToken), revoke = useMutation(api.connectors.revoke), setDelegatable = useMutation(api.issueActivity.setDelegatable);
  const canWrite = workspace.role !== "viewer";
  const [name, setName] = useState(""), [write, setWrite] = useState(canWrite), [days, setDays] = useState(90);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [now] = useState(() => Date.now());
  const url = typeof window === "undefined" ? "" : `${localAppOrigin()}/api/mcp`;
  const active = grants?.filter(g => !g.revoked && g.expiresAt > now);
  const attempt = async (fn: () => Promise<void>) => { setBusy(true); setNotice(""); try { await fn(); } catch (e) { setNotice(errorText(e, "Something went wrong")); } finally { setBusy(false); } };
  const submit = (event: FormEvent) => { event.preventDefault(); void attempt(async () => { const result = await createToken({ sessionToken, teamId: workspace._id, name: name.trim(), write: write && canWrite, days }); setCreated({ token: result.token, name: name.trim() }); setName(""); }); };

  return <div className="agent-settings">
    <div className="agent-url"><Plug size={15} /><input aria-label="MCP server URL" value={url} readOnly onFocus={e => e.currentTarget.select()} /><CopyButton value={url} label="Copy MCP URL" /></div>

    <ClientSetup url={url} token={created?.token} clients={["Claude Code", "Codex", "Cursor", "OpenCode", "Hermes", "OpenClaw", "omp", "Other MCP client"]} />
    {!created && <p className="settings-note">Create a token below and these snippets fill it in. Clients that sign in with OAuth (Claude.ai, ChatGPT) are under Settings → Integrations.</p>}

    <section className="settings-group">
      <h4>How agents work here</h4>
      <p className="settings-note">An agent is one of your connections that you mark as taking issues. People delegate an issue to it from the issue&apos;s Agent field; the human assignee stays. The agent hears about it through the issue.delegated webhook and <code>get_inbox</code>, and reports back in the issue&apos;s Activity.</p>
      <p className="settings-note">The rule doesn&apos;t change: an agent refines the issue with its owner first, in comments. It builds only after the owner confirms. Needs spec stays a note until it has a description and acceptance criteria. Delegating starts nothing on its own.</p>
    </section>

    <section className="settings-group">
      <h4>Tools</h4>
      <p className="settings-note">Agents act as you, with your project access. To work an issue, an agent takes the branch name from <code>get_issue</code> or writes “Closes ORI-AB12” in its pull request; Origin links the PR and completes the issue when it merges.</p>
      <dl className="agent-tools">{MCP_TOOLS.map(tool => <div key={tool.name}><dt><code>{tool.name}</code>{tool.write && <span>write</span>}</dt><dd>{tool.description}</dd></div>)}</dl>
    </section>

    <section className="settings-group">
      <h4>Access tokens</h4>
      <form className="agent-token-form" onSubmit={submit}>
        <input aria-label="Token name" placeholder="Name" value={name} maxLength={60} required onChange={e => setName(e.target.value)} />
        <select aria-label="Access" value={write && canWrite ? "write" : "read"} disabled={!canWrite} onChange={e => setWrite(e.target.value === "write")}><option value="write">Read & write</option><option value="read">Read only</option></select>
        <select aria-label="Expires" value={days} onChange={e => setDays(Number(e.target.value))}><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select>
        <button className="primary-button compact" disabled={busy || !name.trim()}>{busy ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />}Create</button>
      </form>
      {created && <div className="agent-new-token"><input aria-label={`Token ${created.name}`} value={created.token} readOnly onFocus={e => e.currentTarget.select()} /><CopyButton value={created.token} label="Copy token" /><small>Copy it now. It is shown once.</small></div>}
      {notice && <p className="notice danger" role="alert">{notice}</p>}
    </section>

    <section className="settings-group">
      <h4>Connected{active?.length ? <span className="settings-count">{active.length}</span> : null}</h4>
      <div className="settings-list connector-grants">
        {active?.map(g => <div className="settings-list-row connector-grant" key={g._id}><span className="settings-row-icon">{g.delegatable ? <AgentMark size={15} /> : <Plug size={15} />}</span><div><strong>{g.name}</strong><small>{g.write ? "Read & write" : "Read only"}{g.delegatable ? " · Takes issues" : ""} · Expires {formatDate(g.expiresAt)}</small></div>
          {g.write && <button type="button" className={g.delegatable ? "ghost-button compact is-on" : "ghost-button compact"} aria-pressed={g.delegatable} disabled={busy} title={g.delegatable ? "Stop taking delegated issues (takes it off its open issues)" : "Let people delegate issues to this connection"} onClick={() => void attempt(async () => { await setDelegatable({ sessionToken, teamId: workspace._id, grantId: g._id, delegatable: !g.delegatable }); })}><Bot size={14} />{g.delegatable ? "Takes issues" : "Take issues"}</button>}<ConfirmButton label={`Revoke ${g.name}`} confirmLabel="Revoke" disabled={busy} icon={<Trash2 size={14} />} onConfirm={() => void attempt(async () => { await revoke({ sessionToken, teamId: workspace._id, grantId: g._id }); })} /></div>)}
        {active && !active.length && <p className="settings-empty">No agents connected</p>}
      </div>
    </section>
  </div>;
}
