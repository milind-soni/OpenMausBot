import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { preloadConnectedApps, type ConnectorInventory } from "@/lib/connected-apps";
import { permissionCell, permissionPatch, type PermissionReason, type PermissionResource } from "@/lib/bot-permission-board";
import { Select } from "./Select";
import { useMcpServers } from "@/lib/mcp-servers";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { EMAIL_SLUG, type EmailStatus } from "../../shared/email";
import { emailAppCard, loadAppCards } from "./bot-settings/useBotApps";
import { cn } from "@/lib/cn";

const reasonKeys: Record<PermissionReason, LocaleKey> = {
  otherBot: "permissionBoard.otherBot",
  globallyOff: "permissionBoard.globallyOff", unavailable: "permissionBoard.unavailable", unknownGrant: "permissionBoard.unknownGrant",
};

type Category = "all" | "service" | "mcp";
const field = "rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus";

export function BotPermissionBoard() {
  const { state, dispatch } = useStore();
  const { servers, error: mcpError, refresh: refreshMcp } = useMcpServers();
  const [services, setServices] = useState<PermissionResource[]>([]);
  const [inventory, setInventory] = useState<ConnectorInventory | null>(null);
  const [emailError, setEmailError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [botQuery, setBotQuery] = useState("");
  const [resourceQuery, setResourceQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(new Set<string>());
  const generation = useRef(0);
  const boardId = useId();

  const load = useCallback(async () => {
    const run = ++generation.current;
    setLoading(true);
    const [next, cards, email] = await Promise.all([
      preloadConnectedApps(true), loadAppCards(),
      api<EmailStatus>("/api/email").catch(() => null),
    ]);
    if (run !== generation.current) return;
    setInventory(next);
    setEmailError(email === null);
    const connected = Object.entries(next.services).filter(([, status]) => status.connected).map(([slug]) => slug);
    if (email?.state === "connected" && !connected.includes(EMAIL_SLUG)) connected.push(EMAIL_SLUG);
    setServices(connected.map(key => ({ kind: "service" as const, key,
      label: key === EMAIL_SLUG ? emailAppCard().label : cards.get(key)?.label ?? key,
    })).sort((a, b) => a.label.localeCompare(b.label)));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  const resources: PermissionResource[] = [...services, ...(servers ?? []).map(server => ({ kind: "mcp" as const, key: server.name, label: server.name, server }))];
  const wantedBot = botQuery.trim().toLocaleLowerCase();
  const wantedResource = resourceQuery.trim().toLocaleLowerCase();
  const bots = state.bots.filter(bot => !bot.hidden && (!wantedBot || [bot.name, bot.section].some(value => value?.toLocaleLowerCase().includes(wantedBot))))
    .sort((a, b) => a.name.localeCompare(b.name));
  const shown = resources.filter(resource => (category === "all" || resource.kind === category)
    && (!wantedResource || [resource.label, resource.key].some(value => value.toLocaleLowerCase().includes(wantedResource))));
  const connected = services.map(resource => resource.key);
  const servicesReady = !loading && inventory?.authoritative === true && !inventory.refused;
  const mcpReady = servers !== null && !mcpError;
  const allReady = servicesReady && mcpReady;

  const apply = async (bot: Bot, resource: PermissionResource, on: boolean) => {
    if (pending.current.has(bot.id) || loading || (resource.kind === "service" ? !servicesReady : !mcpReady)) return;
    if (permissionCell(bot, resource, servers ?? []).reason) return;
    pending.current.add(bot.id);
    setSaving(new Set(pending.current));
    setError("");
    setNotice("");
    try {
      const fresh = await api<{ bots: Bot[] }>("/api/bots?messages=0");
      const current = fresh.bots.find(entry => entry.id === bot.id);
      if (!current) throw new Error(t("permissionBoard.botGone"));
      dispatch({ type: "botPatched", bot: current });
      if (resource.kind === "service" && !on && emailError && !current.connectorScopes && permissionCell(current, resource, []).checked) {
        throw new Error(t("permissionBoard.emailError"));
      }
      const patch = permissionPatch(current, resource, on, connected, servers ?? []);
      if (patch === null) {
        const reason = permissionCell(current, resource, servers ?? []).reason;
        if (reason) throw new Error(t(reasonKeys[reason]));
        return;
      }
      if (Object.keys(patch).length === 0) return;
      const result = await api<{ bot: Bot }>(`/api/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      if (!result.bot || result.bot.id !== bot.id) throw new Error(t("permissionBoard.invalidResponse"));
      dispatch({ type: "botPatched", bot: result.bot });
      setNotice(t("permissionBoard.saved", { bot: bot.name, resource: resource.label }));
    } catch (cause) {
      setError(`${bot.name} · ${resource.label}: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      pending.current.delete(bot.id);
      setSaving(new Set(pending.current));
    }
  };

  return <div data-permission-board className="flex min-w-0 flex-col gap-2.5">
    <p className="text-[13px] leading-relaxed text-ink-secondary">{t("permissionBoard.intro")}</p>
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-36 flex-1 flex-col gap-1 text-[12px] text-ink-secondary">{t("permissionBoard.searchBots")}
        <input type="search" dir="auto" value={botQuery} onChange={event => setBotQuery(event.target.value)} className={cn(field, "w-full")} />
      </label>
      <label className="flex min-w-36 flex-1 flex-col gap-1 text-[12px] text-ink-secondary">{t("permissionBoard.searchResources")}
        <input type="search" dir="auto" value={resourceQuery} onChange={event => setResourceQuery(event.target.value)} className={cn(field, "w-full")} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">{t("permissionBoard.category")}
        <Select variant="field" size="md" value={category} onChange={event => setCategory(event.target.value as Category)}>
          <option value="all">{t("permissionBoard.all")}</option>
          <option value="service">{t("permissionBoard.services")}</option>
          <option value="mcp">MCP</option>
        </Select>
      </label>
      <button type="button" className="ui-button" disabled={loading || saving.size > 0} onClick={() => { void load(); void refreshMcp(); }}>{t("permissionBoard.refresh")}</button>
    </div>
    {loading && <p role="status" className="text-[13px] text-ink-secondary">{t("permissionBoard.loading")}</p>}
    {!loading && !servicesReady && <p role="alert" className="text-[13px] text-danger">{t("permissionBoard.inventoryError")}</p>}
    {mcpError && <p role="alert" className="text-[13px] text-danger">{t("permissionBoard.mcpError")}</p>}
    {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    <p role="status" aria-live="polite" className="text-[12px] text-ink-secondary">{notice || t("permissionBoard.autoSave")}</p>
    {bots.length === 0 ? <p className="text-[13px] text-ink-secondary">{t("permissionBoard.noBots")}</p>
      : shown.length === 0 ? !loading && <p className="text-[13px] text-ink-secondary">{t(allReady && resources.length === 0 ? "permissionBoard.noResources" : "permissionBoard.noMatch")}</p>
      : <div role="region" aria-label={t("permissionBoard.table")} tabIndex={0} className="max-h-[65vh] min-w-0 overflow-auto rounded-lg border border-hairline/40 focus-visible:outline-2 focus-visible:outline-focus">
        <table className="w-full border-separate border-spacing-0 text-[12px]">
          <caption className="sr-only">{t("permissionBoard.table")}</caption>
          <thead>
            <tr>
              <th scope="col" rowSpan={2} className="sticky start-0 top-0 z-30 min-w-32 border-b border-hairline/40 bg-card px-2 py-1.5 text-start">{t("permissionBoard.bot")}</th>
              {shown.some(resource => resource.kind === "service") && <th scope="colgroup" colSpan={shown.filter(resource => resource.kind === "service").length} className="sticky top-0 z-20 h-6 border-b border-hairline/40 bg-card px-2 text-center text-[12px] font-medium text-ink-secondary">{t("permissionBoard.services")}</th>}
              {shown.some(resource => resource.kind === "mcp") && <th scope="colgroup" colSpan={shown.filter(resource => resource.kind === "mcp").length} className="sticky top-0 z-20 h-6 border-b border-hairline/40 bg-card px-2 text-center text-[12px] font-medium text-ink-secondary">MCP</th>}
            </tr>
            <tr>
              {shown.map(resource => <th key={`${resource.kind}:${resource.key}`} scope="col" className="sticky top-6 z-20 min-w-24 max-w-44 border-b border-hairline/40 bg-card px-2 py-1.5 text-center">
                <span dir="auto" className="block max-w-44 truncate font-medium" title={resource.label}>{resource.label}</span>
              </th>)}
            </tr>
          </thead>
          <tbody>{bots.map((bot, index) => {
            const granted = shown.filter(resource => permissionCell(bot, resource, servers ?? []).checked).length;
            const shade = index % 2 === 1 ? "bg-ink/[0.02]" : "";
            const busyId = `${boardId}-${encodeURIComponent(bot.id)}-busy`;
            return <tr key={bot.id} data-permission-bot={bot.id} aria-busy={saving.has(bot.id)} className="group/row">
            <th scope="row" className="sticky start-0 z-10 max-w-44 border-b border-hairline/30 bg-card px-2 py-1 text-start font-medium">
              <span dir="auto" className="block truncate" title={bot.name}>{bot.name}</span>
              {bot.busy
                ? <span id={busyId} className="block truncate text-[12px] font-normal text-ink-secondary" title={t("botAccess.nextTurn")}>{t("botAccess.nextTurn")}</span>
                : <span className="block truncate text-[12px] font-normal tabular-nums text-ink-secondary" title={bot.section}>
                    {bot.section ? `${bot.section} · ` : ""}{granted}/{shown.length}
                  </span>}
            </th>
            {shown.map(resource => {
              const cell = permissionCell(bot, resource, servers ?? []);
              const reason = cell.reason ? t(reasonKeys[cell.reason]) : "";
              const warning = cell.warning ? t(reasonKeys[cell.warning]) : "";
              const unavailable = loading || saving.has(bot.id) || (resource.kind === "service" ? !servicesReady : !mcpReady);
              const detail = reason || warning || (cell.checked && (cell.readOnly || cell.limited) ? t(cell.readOnly ? "permissionBoard.readOnly" : "permissionBoard.limited") : "");
              const detailId = `${boardId}-${encodeURIComponent(bot.id)}-${resource.kind}-${encodeURIComponent(resource.key)}`;
              const describedBy = [detail && detailId, bot.busy && busyId].filter(Boolean).join(" ") || undefined;
              return <td key={`${resource.kind}:${resource.key}`} className={cn("border-b border-hairline/30 px-1 py-1 text-center align-middle group-hover/row:bg-ink/[0.06] group-focus-within/row:bg-ink/[0.06]", shade)}>
                <label className={cn("flex min-h-8 touch:min-h-11 flex-col items-center justify-center gap-1", !cell.reason && !unavailable && "cursor-pointer")} title={detail || t("permissionBoard.toggle", { bot: bot.name, resource: resource.label })}>
                  <input type="checkbox" checked={cell.checked} disabled={Boolean(cell.reason) || unavailable}
                    aria-label={t("permissionBoard.toggle", { bot: bot.name, resource: resource.label })} aria-describedby={describedBy}
                    onChange={event => void apply(bot, resource, event.target.checked)} className="size-4 accent-accent disabled:cursor-not-allowed disabled:opacity-50" />
                  {detail && <span id={detailId} className="max-w-32 text-[12px] leading-4 text-ink-secondary">{detail}</span>}
                </label>
              </td>;
            })}
          </tr>; })}</tbody>
        </table>
      </div>}
    {emailError && <p role="alert" className="text-[13px] text-danger">{t("permissionBoard.emailError")}</p>}
    <details className="rounded-lg bg-inset px-3 py-1.5">
      <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary">{t("permissionBoard.notes")}</summary>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{t("permissionBoard.scopeNote")}</p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{t("permissionBoard.mcpNote")}</p>
    </details>
  </div>;
}
