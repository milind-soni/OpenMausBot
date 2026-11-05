import { useCallback, useEffect, useRef, useState } from "react";
import { Cable, Check, ExternalLink, Loader2, MoreHorizontal } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { OPENCONNECTOR_API, openConnectorErrorText } from "@/lib/openconnector";
import { isOpenConnectorStatus, OPENCONNECTOR_DEFAULT_COMMAND, OPENCONNECTOR_DEFAULT_URL, type OpenConnectorStatus } from "../../shared/openconnector";
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";

const pill = "inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink transition-colors hover:bg-raised-hover disabled:opacity-40";
const field = "h-8 w-full min-w-0 rounded-lg bg-inset px-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent/50";

/** A neutral mark for OpenConnector: its artwork is not bundled. */
export function OpenConnectorIcon() {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-raised text-ink-secondary" aria-hidden="true">
      <Cable size={20} strokeWidth={1.8} />
    </span>
  );
}

/** The OpenConnector card in Apps: the self-hosted app catalog, connected as the `openconnector` MCP server. OpenMausBot
 * can run the local process (start, health-check, restart, stop), or only connect to one the person runs. */
export function OpenConnectorCard({ refreshKey = 0, onConnection }: {
  refreshKey?: number;
  /** true once connected, false otherwise, null until the server has answered */
  onConnection?: (connected: boolean | null) => void;
}) {
  const { dispatch } = useStore();
  const [status, setStatus] = useState<OpenConnectorStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState(OPENCONNECTOR_DEFAULT_URL);
  const [command, setCommand] = useState(OPENCONNECTOR_DEFAULT_COMMAND);
  const [argsText, setArgsText] = useState("");
  const mounted = useRef(true);

  const load = useCallback(async (check = false): Promise<OpenConnectorStatus | null> => {
    try {
      const response = await api(check ? `${OPENCONNECTOR_API}/check` : OPENCONNECTOR_API, check ? { method: "POST" } : undefined);
      if (!mounted.current) return null;
      if (!isOpenConnectorStatus(response)) throw new Error("unexpected OpenConnector status");
      setStatus(response);
      setLoadFailed(false);
      return response;
    } catch (cause) {
      if (!mounted.current) return null;
      if ((cause as { status?: number }).status === 403) setHidden(true);
      else setLoadFailed(true);
      return null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load, refreshKey]);

  const connected = status?.state === "connected";
  useEffect(() => {
    onConnection?.(status ? connected : null);
  }, [status, connected, onConnection]);

  const applied = (config: ConfigStatus) => dispatch({ type: "configStatus", config });

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const args = argsText.split("\n").map((line) => line.trim()).filter(Boolean);
      const patch: { url: string; command: string; args: string[] } = { url: url.trim(), command: command.trim(), args };
      applied(await api("/api/config", { method: "PUT", body: JSON.stringify({ openconnector: patch }) }));
      const result = await api(`${OPENCONNECTOR_API}/connect`, { method: "POST" }) as OpenConnectorStatus;
      if (!mounted.current) return;
      if (!isOpenConnectorStatus(result)) throw new Error("unexpected OpenConnector status");
      setStatus(result);
      setFormOpen(false);
    } catch (cause) {
      if (mounted.current) {
        setError(openConnectorErrorText(cause));
        await load();
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const disconnect = async () => {
    if (busy || !window.confirm(t("openconnector.disconnectConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api(OPENCONNECTOR_API, { method: "DELETE" }) as OpenConnectorStatus;
      if (mounted.current) setStatus(result);
    } catch (cause) {
      if (mounted.current) setError(openConnectorErrorText(cause));
    } finally {
      if (mounted.current) {
        setBusy(false);
        await load();
      }
    }
  };

  if (hidden) return null;
  const waiting = busy;
  const taken = status?.state === "taken";
  const blocked = status?.state === "blocked";
  const failed = status?.state === "error";
  const description = taken ? t("openconnector.taken")
    : blocked ? status?.message ?? t("openconnector.description")
      : connected
        ? t(status?.managed ? "openconnector.connectedManaged" : "openconnector.connectedTo", { host: status?.host ?? "" })
        : failed ? t("openconnector.failed")
          : t("openconnector.description");
  const menu = (connected || failed) && (
    <SidebarPopoverMenu
      placement="below"
      ariaLabel={t("openconnector.menu")}
      triggerClassName="shrink-0"
      items={[{ key: "disconnect", label: t("connectors.disconnect"), disabled: busy, onSelect: () => void disconnect() }]}
      renderTrigger={() => (
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-control/80 text-ink hover:bg-raised-hover">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={15} aria-hidden="true" />}
        </span>
      )}
    />
  );
  const offerConnect = status !== null && !connected && !taken && !blocked;

  return (
    <div data-app-tile="openconnector" data-openconnector-state={status?.state ?? "loading"} className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40">
      <div className="flex items-center gap-3">
        <OpenConnectorIcon />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-ink">OpenConnector</span>
            {connected && <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />}
          </div>
          <p className="truncate text-[13px] leading-[18px] text-ink-secondary" title={description}>{description}</p>
        </div>
        {waiting ? (
          <button type="button" disabled className={pill} aria-label={t("common.checking")}><Loader2 size={14} className="animate-spin" /></button>
        ) : status === null ? (
          loadFailed
            ? <button type="button" onClick={() => void load()} className={pill}>{t("connectors.action.retry")}</button>
            : <button type="button" disabled className={pill} aria-label={t("common.checking")}><Loader2 size={14} className="animate-spin" /></button>
        ) : connected ? menu : offerConnect && !formOpen ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" aria-label={t(failed ? "openconnector.reconnect" : "openconnector.connect")} disabled={busy}
              onClick={() => {
                setUrl(status?.url ?? OPENCONNECTOR_DEFAULT_URL);
                setCommand(status?.command ?? OPENCONNECTOR_DEFAULT_COMMAND);
                setArgsText((status?.args ?? []).join("\n"));
                setFormOpen(true);
              }} className={pill}>
              {t(failed ? "connectors.action.reconnect" : "connectors.action.connect")}
            </button>
            {menu}
          </div>
        ) : null}
      </div>
      <div className="ps-[52px]">
        {status?.state === "connected" && status.tools !== undefined && (
          <p className="mt-1.5 text-[12px] text-ink-secondary">{t("openconnector.tools", { count: status.tools })}</p>
        )}
        {failed && status?.message && <p role="alert" className="mt-1.5 text-[12px] text-danger">{status.message}</p>}
        {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
        {offerConnect && formOpen && (
          <form data-openconnector-form className="mt-2 flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
            <input type="text" autoComplete="off" spellCheck={false} aria-label={t("openconnector.addressField")} placeholder={OPENCONNECTOR_DEFAULT_URL}
              value={url} disabled={busy} onChange={(event) => { setError(null); setUrl(event.target.value); }} className={field} />
            <input type="text" autoComplete="off" spellCheck={false} aria-label={t("openconnector.commandField")} placeholder={OPENCONNECTOR_DEFAULT_COMMAND}
              value={command} disabled={busy} onChange={(event) => { setError(null); setCommand(event.target.value); }} className={field} />
            <textarea aria-label={t("openconnector.argsField")} rows={2} placeholder={t("openconnector.argsPlaceholder")}
              value={argsText} disabled={busy} onChange={(event) => { setError(null); setArgsText(event.target.value); }} className={`${field} h-auto py-1.5`} />
            <p className="text-[12px] leading-relaxed text-ink-secondary">{t("openconnector.formHelp")}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <button type="submit" disabled={busy || !url.trim()} className={pill}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : t("connectors.action.connect")}
              </button>
              <a href="https://openconnector.dev" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] font-medium text-accent-text hover:underline">
                {t("openconnector.siteLink")}
                <ExternalLink size={11} aria-hidden="true" />
              </a>
              <button type="button" onClick={() => { setFormOpen(false); setError(null); }} className="text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink">
                {t("common.cancel")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
