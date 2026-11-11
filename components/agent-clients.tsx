"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";

// Copy-paste setup for every client that can talk to Origin's MCP server. Syntax checked against each product's own
// docs (2026-11). With a personal access token the snippet sends it as a bearer header; without one the client signs
// in through OAuth (discovery + dynamic client registration), which needs Origin on a public HTTPS address.

export const CLIENTS = ["Claude.ai", "Claude Code", "ChatGPT", "Cursor", "Codex", "OpenCode", "Hermes", "OpenClaw", "omp", "T3 Code", "Other MCP client", "Webhook"] as const;
export type Client = typeof CLIENTS[number];
type Setup = { file?: string; code?: string; note?: string; steps?: string[] };

export function clientSetup(client: Client, url: string, token?: string): Setup {
  const bearer = `Bearer ${token}`;
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  switch (client) {
    case "Claude.ai": return {
      steps: ["Customize → Connectors → Add custom connector.", "Name it Origin. Paste the URL below. Leave the OAuth client fields empty; Origin registers the client itself.", "Connect, sign in to Origin, approve. Team and Enterprise owners add it once under Organization settings → Connectors."],
      code: url, note: "Needs Origin on public HTTPS. A localhost URL will not work from claude.ai.",
    };
    case "Claude Code": return token
      ? { code: `claude mcp add --transport http origin ${url} --header "Authorization: ${bearer}"` }
      : { code: `claude mcp add --transport http origin ${url}`, note: "Then run /mcp in Claude Code and pick origin to sign in." };
    case "ChatGPT": return {
      steps: ["Settings → Apps → Advanced settings → turn on Developer mode.", "Create an app (custom MCP connector). Paste the URL below and choose OAuth.", "Sign in to Origin and approve."],
      code: url, note: "OAuth only. ChatGPT can't send a bearer token, so a personal access token is no use here. Needs public HTTPS.",
    };
    case "Cursor": return { file: "~/.cursor/mcp.json", code: json({ mcpServers: { origin: { url, ...(token ? { headers: { Authorization: bearer } } : {}) } } }), ...(token ? {} : { note: "Cursor opens the Origin sign-in the first time it connects." }) };
    case "Codex": return token
      ? { file: "~/.codex/config.toml", code: `[mcp_servers.origin]\nurl = "${url}"\nbearer_token_env_var = "ORIGIN_TOKEN"`, note: "Put the token in ORIGIN_TOKEN in the shell that starts Codex." }
      : { code: `codex mcp add origin --url ${url}\ncodex mcp login origin` };
    case "OpenCode": return { file: "opencode.json", code: json({ $schema: "https://opencode.ai/config.json", mcp: { servers: { origin: { type: "remote", url, ...(token ? { oauth: false, headers: { Authorization: "Bearer {env:ORIGIN_TOKEN}" } } : {}) } } } }), note: token ? "Put the token in ORIGIN_TOKEN." : "Then run opencode mcp auth origin." };
    case "Hermes": return token
      ? { file: "~/.hermes/config.yaml", code: `mcp_servers:\n  origin:\n    url: "${url}"\n    headers:\n      Authorization: "${bearer}"` }
      : { file: "~/.hermes/config.yaml", code: `mcp_servers:\n  origin:\n    url: "${url}"\n    auth: oauth`, note: "Then run hermes mcp login origin. On a headless box add --flow device." };
    case "OpenClaw": return token
      ? { file: "OpenClaw config (mcp.servers)", code: json({ mcp: { servers: { origin: { url, transport: "streamable-http", headers: { Authorization: bearer } } } } }) }
      : { code: `openclaw mcp set origin '${JSON.stringify({ url, transport: "streamable-http", auth: "oauth" })}'\nopenclaw mcp login origin`, note: "Check it with openclaw mcp doctor origin --probe." };
    case "omp": return { file: "~/.omp/agent/mcp.json", code: json({ mcpServers: { origin: { type: "http", url, ...(token ? { headers: { Authorization: bearer } } : {}) } } }), ...(token ? {} : { note: "Then run /mcp reauth origin in omp to sign in." }) };
    case "T3 Code": return { note: "T3 Code uses your Codex, Claude Code or OpenCode setup. Configure one of those." };
    case "Other MCP client": return {
      steps: [
        "Transport: Streamable HTTP at the URL below. Read-only clients can use /api/mcp/readonly.",
        "OAuth 2.1: the client finds everything from the 401 (RFC 9728 metadata), registers itself (RFC 7591) or sends a client ID metadata document, and uses PKCE.",
        "No OAuth: create a personal access token under Settings → Agents and send Authorization: Bearer <token>.",
        "Rakazo, OpenBot and anything not listed here go this way. Rakazo adds MCP servers on its Integrations page and signs in with OAuth. We couldn't pin down which product \"openbot\" refers to, so there are no product-specific steps for it.",
      ],
      code: token ? `curl -s ${url} -H "Authorization: ${bearer}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` : url,
    };
    case "Webhook": return {
      steps: [
        "For bots that don't speak MCP. Settings → Workspace → Issue webhook: paste an HTTPS URL. Origin signs each POST.",
        "Events: issue.created, issue.updated (status or completion) and issue.delegated (an agent was put on or taken off an issue).",
        "Reply through MCP or the origin CLI with a token. A delegated issue is a request to look, not to build: refine it with the owner in comments first, and build only after they confirm.",
      ],
    };
  }
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="icon-button" aria-label={label} title={label} onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1600); } catch { /* clipboard unavailable */ } }}>{done ? <Check size={15} /> : <Copy size={15} />}</button>;
}

/** Client tabs and the chosen client's setup. */
export function ClientSetup({ url, token, clients = CLIENTS }: { url: string; token?: string; clients?: readonly Client[] }) {
  const [client, setClient] = useState<Client>(clients[0]!);
  const setup = clientSetup(client, url, token);
  return <>
    <div className="agent-clients" role="tablist" aria-label="Client">{clients.map(item => <button key={item} type="button" role="tab" aria-selected={client === item} className={client === item ? "active" : ""} onClick={() => setClient(item)}>{item}</button>)}</div>
    <div className="agent-setup" role="tabpanel" aria-label={`${client} setup`}>
      {setup.steps && <ol className="agent-steps">{setup.steps.map(step => <li key={step}>{step}</li>)}</ol>}
      {setup.file && <small className="agent-file">{setup.file}</small>}
      {setup.code && <div className="agent-snippet"><pre><code>{setup.code}</code></pre><CopyButton value={setup.code} label={`Copy ${client} setup`} /></div>}
      {setup.note && <p>{setup.note}</p>}
    </div>
  </>;
}
