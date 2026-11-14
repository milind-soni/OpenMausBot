import { t } from "@/lib/i18n";
import { Fragment, useEffect, useRef, useState } from "react";
import { Laptop, Loader2, Plus } from "lucide-react";
import { SETTINGS_INPUT, SettingRow, SettingsField, SettingsFoldRow, SettingsGroup, SettingsRows, Switch } from "./SettingsPrimitives";
import { useAdvancedMode } from "@/lib/interface-mode";
import { ComputerSharingSettings } from "./ComputerSharingSettings";
import { ServerList, type OwnServerSharing } from "./ServerList";
import { useStore } from "@/state/store";
import { sharedComputersEnabled } from "@/lib/feature-flags";

type SavedWorkspaces = Awaited<ReturnType<NonNullable<NonNullable<Window["ogb"]>["environments"]>["state"]>>;


/** Your computers (the places list, with its label), then Environments on this computer as a section of its own. */
export function ConnectedWorkspacesSettings({ label, description }: { label?: string; description?: string } = {}) {
  const advanced = useAdvancedMode();
  const [newOpen, setNewOpen] = useState(false);
  const bridge = window.ogb?.environments;
  // Security: the desktop bridge alone is not enough; never offer access the server refuses.
  const { state } = useStore();
  const sharingOffered = sharedComputersEnabled(state.config) && Boolean(window.ogb?.computerSharing);
  // A server of the person's own takes this computer without that flag, once they allow it in main's popup.
  const sharing = window.ogb?.computerSharing;
  const [ownServers, setOwnServers] = useState<OwnServerSharing[]>([]);
  const [saved, setSaved] = useState<SavedWorkspaces | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [computerId, setComputerId] = useState<string | null>(() => new URLSearchParams(window.location?.search ?? "").get("share-computer"));
  const [envName, setEnvName] = useState("");
  const [envDir, setEnvDir] = useState("");
  const [envForget, setEnvForget] = useState<string | null>(null);
  const [envPurge, setEnvPurge] = useState(false);
  const [envError, setEnvError] = useState("");
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    void bridge?.state().then((state) => { if (generation.current === current) setSaved(state); })
      .catch(() => { if (generation.current === current) setError(t("servers.loadFailed")); });
    return () => { generation.current++; };
  }, [bridge]);
  useEffect(() => {
    if (!sharing?.servers || !saved) return;
    let current = true;
    const read = () => void sharing.servers!().then((next) => { if (current) setOwnServers(next); }).catch(() => {});
    read();
    const timer = setInterval(read, 5000);
    return () => { current = false; clearInterval(timer); };
  }, [sharing, saved]);
  const share = (id: string, on: boolean) => void perform(async () => {
    if (on) { if (await sharing?.allow?.(id)) setComputerId(id); } else await sharing?.revoke(id);
    if (sharing?.servers) setOwnServers(await sharing.servers());
  });
  useEffect(() => {
    const consume = (id?: string | null) => {
      if (id) setComputerId(id);
      const url = new URL(window.location.href);
      url.searchParams.delete("share-computer");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    };
    consume();
    return bridge?.onOpenSettings?.(consume);
  }, [bridge]);
  const perform = async (action: () => Promise<unknown>, fail: (message: string) => void = setError) => {
    if (pending.current || !bridge) return;
    pending.current = true; setBusy(true); setError(""); setEnvError("");
    const current = generation.current;
    try {
      // Security: a successful switch unloads this renderer; never ask for its privileged saved list again after the
      // origin changes.
      if (await action() === true) return;
      const state = await bridge.state();
      if (generation.current === current) setSaved(state);
    } catch (nextError) {
      if (generation.current === current) fail(String((nextError as Error)?.message ?? nextError)
        .replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    } finally {
      pending.current = false;
      if (generation.current === current) setBusy(false);
    }
  };
  if (!bridge) return <p className="text-[13px] text-ink-secondary">{t("servers.desktopOnly")}</p>;
  const confirmAction = (message: string) => window.ogb?.confirm ? window.ogb.confirm(message) : window.confirm(message);
  const connected = saved?.environments.find(entry => entry.id === computerId);
  const computerWorkspace = connected?.origin && !connected.home ? { id: connected.id, name: connected.name, origin: connected.origin } : undefined;
  const ownComputer = Boolean(computerWorkspace && ownServers.some((own) => own.id === computerWorkspace.id));
  const locals = saved?.environments.filter(entry => entry.kind === "local") ?? [];
  const forgetEntry = locals.find(entry => entry.id === envForget);
  // This computer's own setups go by the place-name function: the first is This computer, never the machine's name.
  // The first one is "Default" here: "This computer" already names the place in Your computers just above.
  const envLabel = (entry: { name: string; dataDir?: string | null }) => (entry.dataDir ? entry.name : t("connectedWorkspaces.defaultName"));
  return <>
    <SettingsGroup label={label} description={description} block="your-computers">
      {!saved ? <SettingsRows><SettingRow title={t(error ? "servers.yours.loadFailed" : "servers.yours.loading")}>{null}</SettingRow></SettingsRows> :
        <ServerList saved={saved} busy={busy} sharingOffered={sharingOffered} ownServers={ownServers} appVersion={window.ogb?.app?.version ?? null} onShare={share}
          onSwitch={(id) => void perform(async () => { await bridge.switch(id); return true; })} onForget={(id) => void perform(() => bridge.forget(id))} onComputerAccess={setComputerId} />}
      {saved && error && <p role="alert" className="px-4 text-[12px] leading-4 text-danger">{error}</p>}
    </SettingsGroup>
    {advanced && saved?.packaged && (
      <SettingsGroup label={t("connectedWorkspaces.localTitle")} description={t("connectedWorkspaces.localSubtitle")} block="environments">
        <SettingsRows icons>
          {locals.map((entry) => {
            const active = entry.id === saved.activeId;
            const confirming = forgetEntry?.id === entry.id;
            return <Fragment key={entry.id}>
              <SettingRow title={envLabel(entry)} leading={<span className="flex size-8 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary"><Laptop size={18} strokeWidth={1.75} aria-hidden="true" /></span>}
                subtitle={<>{entry.dataDir ?? t("connectedWorkspaces.mainFolder")}{entry.missing && <> · {t("connectedWorkspaces.missing")}</>}</>}>
                {active ? <span className="text-[13px] leading-5 text-ink-secondary">{t("connectedWorkspaces.current")}</span> : <>
                  <button type="button" disabled={busy} aria-label={t("connectedWorkspaces.switchTo", { name: entry.name })} className="ui-button"
                    onClick={() => void perform(async () => {
                      if (!await confirmAction(t("connectedWorkspaces.switchConfirm", { name: entry.name }))) return;
                      const result = await bridge.switch(entry.id);
                      if (result && result.ok === false) throw new Error(t("connectedWorkspaces.switchError"));
                      return true;
                    }, setEnvError)}>{t("connectedWorkspaces.switch")}</button>
                  {!forgetEntry && <button type="button" disabled={busy} data-danger="" aria-label={t("connectedWorkspaces.forgetName", { name: entry.name })} className="settings-quiet cursor-pointer"
                    onClick={() => { setEnvForget(entry.id); setEnvPurge(false); }}>{t("connectedWorkspaces.forget")}</button>}
                </>}
              </SettingRow>
              {confirming && forgetEntry && (
                <div data-env-forget="" className="flex flex-col gap-2 py-3 pl-[60px] pr-4">
                  <span className="flex items-center justify-between gap-6 text-[12px] leading-4 text-ink-secondary">
                    {t("connectedWorkspaces.forgetPurge", { path: forgetEntry.dataDir ?? "" })}
                    <Switch checked={envPurge} disabled={busy} aria-label={t("connectedWorkspaces.forgetPurge", { path: forgetEntry.dataDir ?? "" })} onClick={() => setEnvPurge(!envPurge)} />
                  </span>
                  <span className="flex justify-end gap-2">
                    <button type="button" onClick={() => setEnvForget(null)} className="ui-button">{t("connectedWorkspaces.cancel")}</button>
                    <button type="button" disabled={busy} data-danger="" onClick={() => void perform(async () => {
                      const result = envPurge ? await bridge.forget(forgetEntry.id, true) : await bridge.forget(forgetEntry.id);
                      if (result && result.ok === false) throw new Error(t("connectedWorkspaces.forgetError"));
                      setEnvForget(null);
                    }, setEnvError)} className="ui-button !bg-danger !text-danger-ink">{t("connectedWorkspaces.forget")}</button>
                  </span>
                </div>
              )}
            </Fragment>;
          })}
          <SettingsFoldRow id="new-environment" title={t("connectedWorkspaces.newEnvironment")} open={newOpen} onToggle={() => setNewOpen(!newOpen)}
            leading={<span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary"><Plus size={18} strokeWidth={1.75} /></span>}>
            <form className="flex flex-col gap-3 py-3 pl-[60px] pr-4" onSubmit={(event) => {
              event.preventDefault();
              if (!envName.trim()) return;
              void perform(async () => {
                const created = await bridge.create(envName.trim(), envDir.trim() || undefined);
                if (!created?.ok) throw new Error(t("connectedWorkspaces.createError"));
                setEnvName(""); setEnvDir("");
              }, setEnvError);
            }}>
              <SettingsField label={t("connectedWorkspaces.name")}>
                <input required value={envName} disabled={busy} maxLength={60} onChange={(event) => setEnvName(event.target.value)} placeholder={t("connectedWorkspaces.environmentPlaceholder")} className={SETTINGS_INPUT} />
              </SettingsField>
              <SettingsField label={t("connectedWorkspaces.dataFolder")}>
                <span className="flex gap-2">
                  <input value={envDir} disabled={busy} onChange={(event) => setEnvDir(event.target.value)} placeholder={t("connectedWorkspaces.defaultFolder")} className={SETTINGS_INPUT} />
                  <button type="button" disabled={busy} className="ui-button shrink-0 self-center" onClick={() => void perform(async () => {
                    const picked = await bridge.pickDir();
                    if (picked?.ok && picked.path) setEnvDir(picked.path);
                  }, setEnvError)}>{t("connectedWorkspaces.choose")}</button>
                </span>
              </SettingsField>
              <button type="submit" disabled={busy || !envName.trim()} className="ui-button gap-2 self-end">
                {busy && <Loader2 size={14} className="animate-spin" />}{t("connectedWorkspaces.create")}
              </button>
            </form>
          </SettingsFoldRow>
        </SettingsRows>
        {envError && <p role="alert" className="px-4 text-[12px] leading-4 text-danger">{envError}</p>}
      </SettingsGroup>
    )}
    {(sharingOffered || ownComputer) && computerWorkspace && <ComputerSharingSettings key={computerWorkspace.id} workspace={computerWorkspace} own={ownComputer} onClose={() => setComputerId(null)} />}
  </>;
}
