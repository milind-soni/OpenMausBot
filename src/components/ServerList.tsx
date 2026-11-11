// Settings → Servers: what this app connects to. Each server saved by hand says how it is reached and how it is doing,
// with the one thing to do when it needs the person; My Cloud and teams are the Admin's. This app never stops a server:
// Remove only forgets it here and signs this app out.
import { useEffect, useState } from "react";
import { Check, Cloud, Copy, Laptop, Plus, X } from "lucide-react";
import { serverTransport } from "../../electron/server-address.mjs";
import type { ServerInstall, ServerStatus } from "../../electron/server-status.mjs";
import { cloudColor } from "@/lib/cloud-look";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { OwnServerLink, RailSheet } from "./PlaceAddSheet";
import { SettingsLinkRow, SettingsRows, SettingsTag, Switch } from "./SettingsPrimitives";
import { CloudTile } from "./cloud-buy/parts";

type Saved = Awaited<ReturnType<NonNullable<NonNullable<Window["ogb"]>["environments"]>["state"]>>;
type Entry = Saved["environments"][number];
type Sheet = { address: string; locked: boolean; title: string } | null;
/** A saved server of the person's own (this desktop is its admin), and how lending this computer to it is. */
export type OwnServerSharing = { id: string; enabled: boolean; connected: boolean; paused: boolean };

const TRANSPORT = { https: "servers.transport.https", tailscale: "servers.transport.tailscale", "private-http": "servers.transport.privateHttp", loopback: "servers.transport.loopback" } as const;
const byHand = (entry: Entry) => entry.kind !== "local" && Boolean(entry.origin) && !entry.home && !entry.cloud && !("team" in entry && entry.team);
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The update command that fits how the server was installed, pinned to this app's version. */
export function updateCommand(install: ServerInstall | null, version: string): string {
  if (install === "docker") return "git pull && ./update.sh";
  if (install === "global") return `npm install -g openmausbot@${version}`;
  if (install === "source") return "git pull && pnpm install";
  return `npx openmausbot@${version} serve`;
}

function UpdateNote({ name, status, appVersion, onHide }: { name: string; status: ServerStatus; appVersion: string; onHide: () => void }) {
  const { state, copy } = useCopyFeedback(updateCommand(status.install, appVersion));
  return <div data-server-behind className="mt-2 flex items-center gap-2 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink">
    <span className="min-w-0 flex-1">{t("servers.behind", { name, server: status.version ?? "", app: appVersion })}</span>
    <button type="button" onClick={copy} className="shrink-0 font-medium text-accent-text hover:underline">{t(state === "copied" ? "servers.copied" : "servers.behind.copy")}</button>
    <button type="button" onClick={onHide} aria-label={t("servers.behind.hide")} className="shrink-0 text-ink-secondary hover:text-ink"><X size={13} /></button>
  </div>;
}

function CopyAddress({ origin, name }: { origin: string; name: string }) {
  const { state, copy } = useCopyFeedback(origin);
  return <button type="button" onClick={copy} aria-label={t("servers.copyAddressFor", { name })} title={t(state === "copied" ? "servers.copied" : "servers.copyAddress")}
    className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink">{state === "copied" ? <Check size={14} /> : <Copy size={14} />}</button>;
}

/** One row's status line, with at most one button. */
function StatusLine({ status, onTryNow, onPairAgain, onEdit }: { status: ServerStatus | undefined; onTryNow: () => void; onPairAgain: () => void; onEdit: () => void }) {
  if (!status || status.state === "connected") return null;
  const action = (label: string, run: () => void) => <button type="button" onClick={run} className="ml-2 font-medium text-accent-text hover:underline">{label}</button>;
  const text = status.state === "checking" ? t("servers.state.checking")
    : status.state === "reconnecting" ? t("servers.state.reconnecting")
    : status.state === "cantReach" ? t("servers.state.cantReach", { time: clock(status.since) })
    : status.state === "signedOut" ? t("servers.state.signedOut") : t("servers.state.insecure");
  const blocked = status.state === "signedOut" || status.state === "insecure";
  return <div data-server-state={status.state} className={blocked || status.state === "cantReach" ? "text-[12px] text-danger" : "text-[12px] text-ink-secondary"}>
    {text}
    {status.state === "cantReach" && action(t("servers.tryNow"), onTryNow)}
    {status.state === "signedOut" && action(t("servers.pairAgain"), onPairAgain)}
    {status.state === "insecure" && action(t("servers.editAddress"), onEdit)}
  </div>;
}

/** "Share this computer" for a server of the person's own: the same switch and words wherever lending is shown. */
function ShareRow({ name, share, busy, onShare, onOpen }: { name: string; share: OwnServerSharing; busy: boolean; onShare: (on: boolean) => void; onOpen: () => void }) {
  const line = !share.enabled ? "servers.share.off" : share.paused ? "servers.share.paused" : "servers.share.on";
  return <div data-server-share={share.id} className="mt-2 flex items-center gap-3 rounded-lg bg-inset px-3 py-2">
    <div className="min-w-0 flex-1">
      <div className="text-[12px] font-medium text-ink">{t("servers.share.title")}</div>
      <div className="text-[12px] text-ink-secondary">{t(line, { name })}</div>
    </div>
    {share.enabled && <button type="button" disabled={busy} onClick={onOpen} className="shrink-0 text-[12px] font-medium text-accent-text hover:underline disabled:opacity-50">{t("servers.share.choose")}</button>}
    <Switch checked={share.enabled} disabled={busy} aria-label={t("servers.share.for", { name })} onClick={() => onShare(!share.enabled)} />
  </div>;
}

export function ServerList({ saved, busy, sharingOffered, ownServers = [], appVersion, onSwitch, onForget, onComputerAccess, onShare = () => {} }: {
  saved: Saved; busy: boolean; sharingOffered: boolean; ownServers?: OwnServerSharing[]; appVersion: string | null;
  onSwitch: (id: string) => void; onForget: (id: string) => void; onComputerAccess: (id: string) => void; onShare?: (id: string, on: boolean) => void;
}) {
  const bridge = window.ogb?.environments;
  const [statuses, setStatuses] = useState<ServerStatus[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [sheet, setSheet] = useState<Sheet>(null);
  useEffect(() => {
    if (!bridge?.status) return;
    let current = true;
    const read = () => void bridge.status!().then((next) => { if (current) setStatuses(next); }).catch(() => {});
    read();
    const stop = bridge.onStatus?.(read);
    return () => { current = false; stop?.(); };
  }, [bridge, saved]);
  const statusOf = (id: string) => statuses.find((status) => status.id === id);
  const pairAgain = (entry: Entry) => setSheet({ address: entry.origin!, locked: true, title: t("servers.pairAgainTitle", { name: entry.name }) });
  const editAddress = (entry: Entry) => setSheet({ address: entry.origin!.replace(/^http:/, "https:"), locked: false, title: t("connect.title") });
  const rows: Entry[] = [{ id: "local", name: t("place.local"), kind: "local" }, ...saved.environments.filter((entry) => entry.kind !== "local")];
  return <>
    <SettingsRows icons>
      {rows.map((entry) => {
        const active = entry.id === saved.activeId;
        const status = byHand(entry) ? statusOf(entry.id) : undefined;
        const Icon = entry.id === "local" ? Laptop : Cloud;
        const where = entry.id === "local" ? t("servers.localHint")
          : !byHand(entry) ? (entry.home ? t("servers.managed") : new URL(entry.origin!).host)
          : `${new URL(entry.origin!).host} · ${t(TRANSPORT[serverTransport(entry.origin!)])}`;
        const share = ownServers.find((own) => own.id === entry.id);
        const showUpdate = status?.behind === true && appVersion !== null && !hidden.includes(`${entry.id}:${status.version}`);
        return <div key={entry.id} data-server-row={entry.id} className="flex flex-col px-4 py-3">
          <div className="flex min-h-10 items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary">
              {cloudColor(entry.color) ? <CloudTile color={entry.color} size={20} /> : <Icon size={18} strokeWidth={1.75} aria-hidden="true" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 truncate text-[14px] leading-5 text-ink">{entry.name}{entry.home && <SettingsTag>{t("servers.homeTag")}</SettingsTag>}</div>
              <div data-server-where className="truncate text-[13px] leading-[18px] text-ink-secondary">{where}</div>
              <StatusLine status={status} onTryNow={() => void bridge?.retry?.(entry.id)} onPairAgain={() => pairAgain(entry)} onEdit={() => editAddress(entry)} />
            </div>
            {active ? <span className="shrink-0 text-[13px] leading-5 text-ink-secondary">{t("servers.current")}</span> :
              <button type="button" disabled={busy} aria-label={t("servers.switchTo", { name: entry.name })} onClick={() => onSwitch(entry.id)} className="ui-button shrink-0">{t("servers.switch")}</button>}
            {byHand(entry) && status?.state !== "signedOut" && <button type="button" disabled={busy} onClick={() => pairAgain(entry)} className="settings-quiet shrink-0 cursor-pointer">{t("servers.pairAgain")}</button>}
            {entry.id !== "local" && !entry.home && !entry.cloud && !share && sharingOffered && <button type="button" disabled={busy} aria-label={t("servers.computerAccessFor", { name: entry.name })} onClick={() => onComputerAccess(entry.id)} className="settings-quiet shrink-0 cursor-pointer">{t("servers.computerAccess")}</button>}
            {byHand(entry) && <CopyAddress origin={entry.origin!} name={entry.name} />}
            {entry.id !== "local" && !entry.home && <button type="button" disabled={busy} data-danger="" aria-label={t("servers.removeName", { name: entry.name })} title={t("servers.removeName", { name: entry.name })}
              onClick={() => onForget(entry.id)} className="settings-quiet shrink-0 cursor-pointer">{t("remote.devices.removeShort")}</button>}
          </div>
          {share && <div className="pl-11"><ShareRow name={entry.name} share={share} busy={busy} onShare={(on) => onShare(entry.id, on)} onOpen={() => onComputerAccess(entry.id)} /></div>}
          {showUpdate && <div className="pl-11"><UpdateNote name={entry.name} status={status!} appVersion={appVersion!} onHide={() => setHidden((list) => [...list, `${entry.id}:${status!.version}`])} /></div>}
        </div>;
      })}
      <SettingsLinkRow title={t("connect.title")} leading={<span className="flex size-8 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary"><Plus size={18} strokeWidth={1.75} aria-hidden="true" /></span>}
        onClick={() => { if (!busy) setSheet({ address: "", locked: false, title: t("connect.title") }); }} data={{ "data-server-connect": "" }} />
    </SettingsRows>
    {sheet && <RailSheet focusKey={sheet.locked ? "pair-again" : "connect"} onClose={() => setSheet(null)}>
      <OwnServerLink onBack={null} onConnected={() => setSheet(null)} start={sheet} />
    </RailSheet>}
  </>;
}
