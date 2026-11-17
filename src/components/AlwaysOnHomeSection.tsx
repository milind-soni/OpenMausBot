// Settings → Phone & devices → Always-on home: a spare computer (a Mac mini, say) as the person's own Cloud at home. On
// that computer, one switch makes it one; on their main computer, the steps to add it and what it then does for them.
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { makeHome } from "@/lib/places";
import { api } from "@/state/store";
import type { LocaleKey } from "@/locales";
import type { ServerStatus } from "../../electron/server-status.mjs";
import type { CompanionState, PhoneSetupController } from "./PhoneSetupFlow";
import { OwnServerLink, RailSheet } from "./PlaceAddSheet";
import { byHand, type SavedServer } from "./ServerList";
import { SettingRow, SettingsFoldRow, SettingsGroup, SettingsRows, Switch } from "./SettingsPrimitives";

type Line = { key: LocaleKey; good: boolean };

const UPDATE_LINE = {
  "by-itself": "alwaysOn.updates.byItself",
  restart: "alwaysOn.updates.restart",
  package: "alwaysOn.updates.package",
  none: "alwaysOn.updates.none",
} as const satisfies Record<AlwaysOnHomeState["updates"], LocaleKey>;

/** What the switch turned on, one line each, as main reads it now. */
export function alwaysOnLines(state: AlwaysOnHomeState): Line[] {
  return [
    { key: state.openAtLogin ? "alwaysOn.login.on" : state.available ? "alwaysOn.login.off" : "alwaysOn.login.unavailable", good: state.openAtLogin },
    { key: state.awake === "holding" ? "alwaysOn.awake.on" : "alwaysOn.awake.battery", good: state.awake === "holding" },
    { key: UPDATE_LINE[state.updates], good: state.updates === "by-itself" },
    { key: "alwaysOn.windowClosed", good: true },
    { key: "alwaysOn.restarts", good: true },
  ];
}

/** What only the computer's own settings can do, in their own names: a Mac's, shown on a Mac only. */
export function systemSettingLines(platform: string): LocaleKey[] {
  return platform === "darwin" ? ["alwaysOn.mac.power", "alwaysOn.mac.login", "alwaysOn.mac.locked", "alwaysOn.mac.permissions"] : [];
}

/** "Home is on · reachable from 2 devices", or "Home is on · nothing paired yet". */
export function homeStatusLine(devices: number): string {
  if (devices <= 0) return t("alwaysOn.status.none");
  return devices === 1 ? t("alwaysOn.status.one") : t("alwaysOn.status.many", { count: devices });
}

/** Phones paired with this computer, and other computers and browsers signed in to it with a pairing code. */
function usePairedCount(state: CompanionState, on: boolean): number {
  const [signedIn, setSignedIn] = useState(0);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    void api("/api/auth/sessions").then((body) => { if (alive) setSignedIn(Array.isArray(body?.sessions) ? body.sessions.length : 0); }).catch(() => {});
    return () => { alive = false; };
  }, [on]);
  return state.devices.length + signedIn;
}

const ogb = () => (typeof window === "undefined" ? undefined : window.ogb);
const isMac = () => ogb()?.platform === "darwin";

/** On the spare computer: one switch, what it did, and the next step (pair a phone, then another computer). */
function ThisComputerHome({ home, setHome, c, state, onAddPhone }: {
  home: AlwaysOnHomeState; setHome: (next: AlwaysOnHomeState) => void; c: PhoneSetupController; state: CompanionState; onAddPhone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const paired = usePairedCount(state, home.on);
  const set = (on: boolean) => {
    const bridge = ogb()?.alwaysOnHome;
    if (!bridge) return;
    setBusy(true); setFailed(false);
    void bridge.set(on).then(setHome, () => setFailed(true)).finally(() => setBusy(false));
  };
  const title = t(isMac() ? "alwaysOn.titleMac" : "alwaysOn.title");
  const computersOn = state.routes?.tailscale?.on === true && state.routes.tailscale.computers === true;
  return (
    <>
      <SettingRow title={title} subtitle={t("alwaysOn.line")}
        message={failed ? <span role="alert" className="text-danger">{t("alwaysOn.failed")}</span>
          : home.on ? <span data-always-on-status="" aria-live="polite">{homeStatusLine(paired)}</span> : undefined}>
        <span data-always-on-switch="" className="contents">
          <Switch checked={home.on} disabled={busy} aria-label={title} onClick={() => set(!home.on)} />
        </span>
      </SettingRow>
      {home.on && <AlwaysOnDetails home={home} c={c} onAddPhone={onAddPhone} canAddComputer={!computersOn} />}
    </>
  );
}

function AlwaysOnDetails({ home, c, onAddPhone, canAddComputer }: { home: AlwaysOnHomeState; c: PhoneSetupController; onAddPhone: () => void; canAddComputer: boolean }) {
  const system = systemSettingLines(home.platform);
  return (
    <div data-always-on-details="" className="flex flex-col gap-3 px-4 py-3">
      <ul className="flex flex-col gap-1 text-[13px] leading-[18px]">
        {alwaysOnLines(home).map((line) => (
          <li key={line.key} data-always-on-line={line.key} className={line.good ? "flex gap-1.5 text-ink" : "flex gap-1.5 text-ink-secondary"}>
            {line.good ? <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-secondary" /> : <span aria-hidden="true" className="w-3.5 shrink-0" />}
            <span>{t(line.key, { app: productName() })}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] leading-[18px] text-ink">{t("alwaysOn.next")}</span>
        <button type="button" className="ui-button ui-button-primary" data-always-on-add-phone="" disabled={c.busy} onClick={onAddPhone}>{t("alwaysOn.addPhone")}</button>
        {canAddComputer && (
          <button type="button" className="ui-button" data-always-on-add-computer="" disabled={c.busy}
            onClick={() => void c.act((companion) => companion.setTailscaleComputers?.(true) ?? companion.state())}>{t("alwaysOn.addComputer")}</button>
        )}
      </div>
      {!canAddComputer && <p className="text-[12px] leading-4 text-ink-secondary">{t("alwaysOn.addComputerOn")}</p>}
      {system.length > 0 && (
        <ul data-always-on-system="" className="flex list-disc flex-col gap-1 pl-4 text-[12px] leading-4 text-ink-secondary">
          {system.map((key) => <li key={key}>{t(key, { app: productName() })}</li>)}
        </ul>
      )}
    </div>
  );
}

/** The servers saved by hand on this computer, read again whenever the Connect sheet closes. */
function useSavedServers(version: number): { servers: SavedServer[]; status: ServerStatus[] } {
  const environments = ogb()?.environments;
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [status, setStatus] = useState<ServerStatus[]>([]);
  useEffect(() => {
    if (!environments) return;
    let alive = true;
    const read = () => {
      void environments.state().then((saved) => { if (alive) setServers(saved.environments.filter(byHand)); }).catch(() => {});
      void environments.status?.().then((rows) => { if (alive) setStatus(rows); }).catch(() => {});
    };
    read();
    const off = environments.onStatus?.(read);
    return () => { alive = false; off?.(); };
  }, [environments, version]);
  return { servers, status };
}

/** One computer added here: how it is doing, and one tap each for what it can do. */
function AddedComputer({ server, status }: { server: SavedServer; status: ServerStatus | undefined }) {
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const move = () => {
    setMoving(true); setSaid(null);
    void makeHome(server.id).then((outcome) => {
      setMoving(false);
      if (outcome === true) setConfirming(false); else setSaid(outcome);
    });
  };
  const health = !status || status.state === "checking" ? t("alwaysOn.added.checking")
    : status.state === "connected" ? t("alwaysOn.added.online") : t("alwaysOn.added.offline");
  return (
    <div data-always-on-computer={server.id} className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] leading-5 text-ink">{server.name}</div>
          <div data-always-on-health={status?.state ?? "checking"} className="text-[12px] leading-4 text-ink-secondary">{health}</div>
        </div>
        <button type="button" className="ui-button" data-always-on-open="" onClick={() => void ogb()?.environments?.switch(server.id)}>{t("alwaysOn.added.open")}</button>
        {!confirming && <button type="button" className="ui-button" data-always-on-move="" onClick={() => setConfirming(true)}>{t("alwaysOn.added.move")}</button>}
      </div>
      {confirming && (
        <div role="group" aria-label={t("rail.makeHome", { name: server.name })} className="flex flex-col gap-2 rounded-lg bg-inset px-3 py-2.5">
          <p className="text-[13px] leading-[18px] text-ink">{t("rail.makeHomeSub", { name: server.name })}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-button ui-button-primary" data-always-on-move-yes="" disabled={moving} aria-busy={moving || undefined} onClick={move}>{t("rail.makeHome", { name: server.name })}</button>
            <button type="button" className="ui-button" disabled={moving} onClick={() => { setConfirming(false); setSaid(null); }}>{t("common.cancel")}</button>
          </div>
          {said && <p role="alert" className="text-[12px] leading-4 text-danger">{said}</p>}
        </div>
      )}
      <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] leading-4 text-ink-secondary">
        <li>{t("alwaysOn.added.sidebar", { name: server.name })}</li>
        <li>{t("alwaysOn.added.keepRunning", { name: server.name })}</li>
        <li>{t("alwaysOn.added.screen", { app: productName() })}</li>
      </ul>
    </div>
  );
}

/** On the person's main computer: the steps to add a spare computer, then each one added and what it can do. */
function AddAlwaysOnComputer() {
  const [asked, setOpen] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [version, setVersion] = useState(0);
  const { servers, status } = useSavedServers(version);
  const title = t("alwaysOn.add.title");
  const open = asked ?? servers.length > 0;
  return (
    <>
      <SettingsFoldRow id="add-always-on" title={title} subtitle={t("alwaysOn.add.line")} open={open} onToggle={() => setOpen(!open)}>
        <ol data-always-on-steps="" className="flex list-decimal flex-col gap-2 px-4 py-3 pl-8 text-[13px] leading-[18px] text-ink">
          <li>{t("alwaysOn.add.step1", { app: productName() })}</li>
          <li>{t("alwaysOn.add.step2")}</li>
          <li className="flex flex-wrap items-center gap-3">
            <span>{t("alwaysOn.add.step3")}</span>
            <button type="button" className="ui-button ui-button-primary" data-always-on-connect="" onClick={() => setConnecting(true)}>{t("alwaysOn.add.connect")}</button>
          </li>
        </ol>
        {servers.map((server) => <AddedComputer key={server.id} server={server} status={status.find((row) => row.id === server.id)} />)}
      </SettingsFoldRow>
      {connecting && <RailSheet focusKey="connect" onClose={() => { setConnecting(false); setVersion((n) => n + 1); }}>
        <OwnServerLink onBack={null} onConnected={() => { setConnecting(false); setVersion((n) => n + 1); }} />
      </RailSheet>}
    </>
  );
}

/** The section: this computer as a home, and adding another computer as one. The second is left out while this one is a home. */
export function AlwaysOnHomeSection({ c, state, onAddPhone }: { c: PhoneSetupController; state: CompanionState; onAddPhone: () => void }) {
  const bridge = ogb()?.alwaysOnHome;
  const [home, setHome] = useState<AlwaysOnHomeState | null>(null);
  useEffect(() => {
    let alive = true;
    void bridge?.state().then((next) => { if (alive) setHome(next); }).catch(() => {});
    return () => { alive = false; };
  }, [bridge]);
  const addHere = Boolean(ogb()?.environments && ogb()?.workspaces?.probe);
  if (!home && !addHere) return null;
  return (
    <SettingsGroup label={t("alwaysOn.section")} block="always-on" description={t("alwaysOn.sectionLine")}>
      <SettingsRows>
        {home && <ThisComputerHome home={home} setHome={setHome} c={c} state={state} onAddPhone={onAddPhone} />}
        {addHere && !home?.on && <AddAlwaysOnComputer />}
      </SettingsRows>
    </SettingsGroup>
  );
}
