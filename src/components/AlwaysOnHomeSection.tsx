// Settings → Devices → Always-on home: a spare computer (a Mac mini, say) as the person's own Cloud at home. On
// that computer, one switch makes it one; on their main computer, the steps to add it and what it then does for them.
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { makeHome } from "@/lib/places";
import { byHand, type SavedServer } from "@/lib/saved-servers";
import { api } from "@/state/store";
import type { LocaleKey } from "@/locales";
import type { ServerStatus } from "../../electron/server-status.mjs";
import type { CompanionState, PhoneSetupController } from "./PhoneSetupFlow";
import { companionRoutesOn } from "./PhoneDevicesSection";
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
    { key: state.platform === "linux" ? "alwaysOn.windowClosedLinux" : "alwaysOn.windowClosed", good: true },
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

/** A computer or browser signed in here counts while it was seen within this long; an old sign-in nobody uses doesn't. */
export const RECENT_SESSION_MS = 14 * 24 * 60 * 60 * 1000;

/** Sessions seen recently, of what /api/auth/sessions lists. */
export function recentSessions(sessions: unknown, now: number): number {
  if (!Array.isArray(sessions)) return 0;
  return sessions.filter((session) => {
    const seen = (session as { lastSeenAt?: unknown } | null)?.lastSeenAt;
    return typeof seen === "number" && now - seen <= RECENT_SESSION_MS;
  }).length;
}

/** Phones paired with this computer, and other computers and browsers signed in to it with a pairing code and seen lately. */
function usePairedCount(state: CompanionState, on: boolean): number {
  const [signedIn, setSignedIn] = useState(0);
  const phones = state.devices.length;
  useEffect(() => {
    if (!on) return;
    let alive = true;
    void api("/api/auth/sessions").then((body) => { if (alive) setSignedIn(recentSessions(body?.sessions, Date.now())); }).catch(() => {});
    return () => { alive = false; };
  }, [on, phones]);
  return phones + signedIn;
}

const ogb = () => (typeof window === "undefined" ? undefined : window.ogb);
const isMac = () => ogb()?.platform === "darwin";

/** On the spare computer: one switch, what it did, and the next step (pair a phone, then another computer). */
function ThisComputerHome({ home, setHome, c, state, onAddPhone, onAddComputer, blocked }: {
  home: AlwaysOnHomeState; setHome: (next: AlwaysOnHomeState) => void; c: PhoneSetupController; state: CompanionState; onAddPhone: () => void; onAddComputer: () => void; blocked: string | null;
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
  return (
    <>
      <SettingRow title={title} subtitle={t("alwaysOn.line")}
        message={failed ? <span role="alert" className="text-danger">{t("alwaysOn.failed")}</span>
          : home.on ? <span data-always-on-status="" aria-live="polite">{companionRoutesOn(state) ? homeStatusLine(paired) : t("alwaysOn.status.noWay")}</span> : undefined}>
        <span data-always-on-switch="" className="contents">
          <Switch checked={home.on} disabled={busy} aria-label={title} onClick={() => set(!home.on)} />
        </span>
      </SettingRow>
      {home.on && <AlwaysOnDetails home={home} c={c} onAddPhone={onAddPhone} onAddComputer={onAddComputer} blocked={blocked} />}
    </>
  );
}

function AlwaysOnDetails({ home, c, onAddPhone, onAddComputer, blocked }: { home: AlwaysOnHomeState; c: PhoneSetupController; onAddPhone: () => void; onAddComputer: () => void; blocked: string | null }) {
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
        <button type="button" className="ui-button ui-button-primary" data-always-on-add-phone="" disabled={c.busy || Boolean(blocked)} title={blocked ?? undefined} onClick={onAddPhone}>{t("alwaysOn.addPhone")}</button>
        <button type="button" className="ui-button" data-always-on-add-computer="" disabled={c.busy || Boolean(blocked)} title={blocked ?? undefined}
          onClick={onAddComputer}>{t("alwaysOn.addComputer")}</button>
      </div>
      {blocked && <p role="status" className="text-[12px] leading-4 text-ink-secondary">{blocked}</p>}
      {system.length > 0 && (
        <ul data-always-on-system="" className="flex list-disc flex-col gap-1 pl-4 text-[12px] leading-4 text-ink-secondary">
          {system.map((key) => <li key={key}>{t(key, { app: productName() })}</li>)}
        </ul>
      )}
    </div>
  );
}

/** The servers saved by hand on this computer, and those main offers Make … my home for now, read again whenever main
 * says the places changed. */
function useSavedServers(): { servers: SavedServer[]; status: ServerStatus[]; offers: string[] } {
  const environments = ogb()?.environments;
  const workspaces = ogb()?.workspaces;
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [status, setStatus] = useState<ServerStatus[]>([]);
  const [offers, setOffers] = useState<string[]>([]);
  useEffect(() => {
    if (!environments) return;
    let alive = true;
    const read = () => {
      void environments.state().then((saved) => { if (alive) setServers(saved.environments.filter(byHand)); }).catch(() => {});
      void environments.status?.().then((rows) => { if (alive) setStatus(rows); }).catch(() => {});
      void workspaces?.homeOffers?.().then((ids) => { if (alive) setOffers(Array.isArray(ids) ? ids : []); }).catch(() => {});
    };
    read();
    const off = environments.onStatus?.(read);
    const offChanged = workspaces?.onChanged?.(read);
    return () => { alive = false; off?.(); offChanged?.(); };
  }, [environments, workspaces]);
  return { servers, status, offers };
}

/** One computer added here: how it is doing, and one tap each for what it can do. Make … my home is the rail menu's own
 * one-tap move, with what it does said under it, shown only while main offers it for this server (`offered`). */
function AddedComputer({ server, status, offered }: { server: SavedServer; status: ServerStatus | undefined; offered: boolean }) {
  const [moving, setMoving] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const move = () => {
    setMoving(true); setSaid(null);
    void makeHome(server.id).then((outcome) => {
      setMoving(false);
      if (outcome !== true) setSaid(outcome);
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
        {offered && <button type="button" className="ui-button" data-always-on-move="" disabled={moving} aria-busy={moving || undefined} onClick={move}>{t("rail.makeHome", { name: server.name })}</button>}
      </div>
      {said && <p role="alert" className="text-[12px] leading-4 text-danger">{said}</p>}
      <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] leading-4 text-ink-secondary">
        <li>{t("alwaysOn.added.sidebar", { name: server.name })}</li>
        {offered && <li>{t("alwaysOn.added.keepRunning", { name: server.name })} {t("rail.makeHomeDataStays", { name: server.name })}</li>}
        <li>{t("alwaysOn.added.screen", { app: productName() })}</li>
      </ul>
    </div>
  );
}

/** On the person's main computer: the steps to add a spare computer, then each one added and what it can do. Connect is
 * Add your own server's steps (`onConnect`). */
function AddAlwaysOnComputer({ onConnect }: { onConnect: () => void }) {
  const [open, setOpen] = useState(false);
  const { servers, status, offers } = useSavedServers();
  const title = t("alwaysOn.add.title");
  return (
    <>
      <SettingsFoldRow id="add-always-on" title={title} subtitle={t("alwaysOn.add.line")} open={open} onToggle={() => setOpen(!open)}>
        <ol data-always-on-steps="" className="flex list-decimal flex-col gap-2 px-4 py-3 pl-8 text-[13px] leading-[18px] text-ink">
          <li>{t("alwaysOn.add.step1Devices", { app: productName() })}</li>
          <li>{t("alwaysOn.add.step2")}</li>
          <li className="flex flex-wrap items-center gap-3">
            <span>{t("alwaysOn.add.step3")}</span>
            <button type="button" className="ui-button ui-button-primary" data-always-on-connect="" onClick={onConnect}>{t("alwaysOn.add.connect")}</button>
          </li>
        </ol>
        {servers.map((server) => <AddedComputer key={server.id} server={server} status={status.find((row) => row.id === server.id)} offered={offers.includes(server.id)} />)}
      </SettingsFoldRow>
    </>
  );
}

/** The section: this computer as a home, and adding another computer as one. The second is left out while this one is a home. */
export function AlwaysOnHomeSection({ c, state, onAddPhone, onAddComputer, onConnect, blocked = null }: {
  c: PhoneSetupController; state: CompanionState; onAddPhone: () => void; onAddComputer: () => void; onConnect: () => void;
  /** the organization's policy keeps remote access off: nothing here turns a way in on */
  blocked?: string | null;
}) {
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
        {home && <ThisComputerHome home={home} setHome={setHome} c={c} state={state} onAddPhone={onAddPhone} onAddComputer={onAddComputer} blocked={blocked} />}
        {addHere && !home?.on && <AddAlwaysOnComputer onConnect={onConnect} />}
      </SettingsRows>
    </SettingsGroup>
  );
}
