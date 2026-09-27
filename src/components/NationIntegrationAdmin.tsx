import { HostedComputerAdmin } from "./HostedComputerAdmin";
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { NationAdminConfig } from "./NationAdminPage";
import { Card } from "./SettingsPrimitives";

const inputClass = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-sm text-ink";

export function NationIntegrationAdmin({ config }: { config: NationAdminConfig }) {
  const [status, setStatus] = useState(config);
  const [composio, setComposio] = useState("");
  const [box, setBox] = useState("");
  const [searchProvider, setSearchProvider] = useState<"openrouter" | "brave" | "tavily">(config.webTools?.search.provider ?? "openrouter");
  const [searchKey, setSearchKey] = useState("");
  const [alias, setAlias] = useState(config.vps?.sshAlias ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setStatus(config); }, [config]);

  const save = async (patch: unknown, clear: () => void) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await api<NationAdminConfig>("/api/config", { method: "PUT", body: JSON.stringify(patch) });
      setStatus(next); clear(); setNotice("Settings saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Settings could not be saved."); }
    finally { setBusy(false); }
  };
  return <div className="space-y-5">
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="text-sm text-success">{notice}</p>}
    <Card title="Connected apps · Composio" subtitle="Connect Gmail, Calendar, and other apps, then choose which agents may use them.">
      <p className="mb-3 text-sm text-ink">{status.composio?.configured ? "Composio configured" : "Composio not configured"}</p>
      <a href="/swarm/connectors" className="text-sm text-accent underline">Open Plugins & connected apps</a>
      <form className="mt-4 space-y-2" onSubmit={event => { event.preventDefault(); if (composio.trim()) void save({ composio: { apiKey: composio.trim() } }, () => setComposio("")); }}>
        <label className="block text-sm text-ink" htmlFor="composio-key">Composio API key</label>
        <input id="composio-key" type="password" autoComplete="new-password" value={composio} onChange={event => setComposio(event.target.value)} placeholder={status.composio?.configured ? "Existing key saved · enter only to replace" : "Enter API key"} className={inputClass} />
        <button disabled={busy || !composio.trim()} className="ui-button disabled:opacity-50">Save Composio key</button>
      </form>
      <p className="mt-3 text-xs text-ink-secondary">Keys stay on the server. Each app still needs its own account connection. Agent access is controlled in the agent's Access settings.</p>
    </Card>
    <Card title="Web search & reader" subtitle="Agents search the web and read pages on NATION's account. Members never set anything up.">
      <p className="mb-3 text-sm text-ink">
        {status.webTools?.enabled === false ? "Turned off for all agents"
          : status.webTools?.search.configured ? `Search on (${status.webTools.search.provider === "openrouter" ? "NATION API web search" : status.webTools.search.provider}); reader on`
            : "Search not configured; reader on"}
      </p>
      {status.webTools && <p className="mb-3 text-xs text-ink-secondary">Charged to each member's credit per use: search ${status.webTools.prices.searchUsd.toFixed(4)} (or the provider's reported cost), page read ${status.webTools.prices.readUsd.toFixed(4)}, before markup.</p>}
      <button type="button" disabled={busy} className="ui-button mb-4 disabled:opacity-50"
        onClick={() => void save({ features: { webTools: status.webTools?.enabled === false } }, () => {})}>
        {status.webTools?.enabled === false ? "Turn web tools on" : "Turn web tools off"}
      </button>
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); void save(searchProvider === "openrouter" ? { webSearch: { provider: "openrouter", apiKey: "" } } : { webSearch: { provider: searchProvider, apiKey: searchKey.trim() } }, () => setSearchKey("")); }}>
        <label className="block text-sm text-ink" htmlFor="search-provider">Search provider</label>
        <select id="search-provider" value={searchProvider} onChange={event => setSearchProvider(event.target.value as typeof searchProvider)} className={inputClass}>
          <option value="openrouter">NATION API web search (uses the NATION API key)</option>
          <option value="brave">Brave Search API</option>
          <option value="tavily">Tavily</option>
        </select>
        {searchProvider !== "openrouter" && <>
          <label className="block text-sm text-ink" htmlFor="search-key">Provider API key</label>
          <input id="search-key" type="password" autoComplete="new-password" value={searchKey} onChange={event => setSearchKey(event.target.value)} placeholder={status.webTools?.search.source === "admin" ? "Existing key saved · enter only to replace" : "Enter API key"} className={inputClass} />
        </>}
        <button disabled={busy || (searchProvider !== "openrouter" && !searchKey.trim())} className="ui-button disabled:opacity-50">Save search provider</button>
      </form>
    </Card>
    <Card title="Cloud computers · Box" subtitle="Hosted Linux computers for agent work.">
      <p className="mb-3 text-sm text-ink">{status.box?.configured ? "Box configured" : "Box not configured"}</p>
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (box.trim()) void save({ box: { token: box.trim() } }, () => setBox("")); }}>
        <label className="block text-sm text-ink" htmlFor="box-token">Box API token</label>
        <input id="box-token" type="password" autoComplete="new-password" value={box} onChange={event => setBox(event.target.value)} placeholder={status.box?.configured ? "Existing token saved · enter only to replace" : "Enter API token"} className={inputClass} />
        <button disabled={busy || !box.trim()} className="ui-button disabled:opacity-50">Save Box token</button>
      </form>
    </Card>
    <HostedComputerAdmin initial={status.hostedComputers} />
    <Card title="Self-hosted VPS" subtitle="Use the configured Linux server for isolated agent computers.">
      <p className="mb-3 text-sm text-ink">{status.vps?.configured ? "VPS configured" : "VPS not configured"}</p>
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (alias.trim()) void save({ vps: { sshAlias: alias.trim() } }, () => {}); }}>
        <label className="block text-sm text-ink" htmlFor="vps-alias">Server SSH alias</label>
        <input id="vps-alias" value={alias} onChange={event => setAlias(event.target.value)} placeholder="Configured server alias" pattern="[A-Za-z0-9_.-]+" className={inputClass} />
        <button disabled={busy || !alias.trim() || alias.trim() === status.vps?.sshAlias} className="ui-button disabled:opacity-50">Save VPS connection</button>
      </form>
      <p className="mt-3 text-xs text-ink-secondary">Choose Cloud in an agent's Computer panel, then select Box or Self-hosted VPS. Changing the computer keeps NATION API and its credit checks.</p>
      <a href="/swarm/" className="mt-3 inline-block text-sm text-accent underline">Open agent computers</a>
    </Card>
  </div>;
}
