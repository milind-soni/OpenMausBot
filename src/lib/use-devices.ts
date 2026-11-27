import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ServerStatus } from "../../electron/server-status.mjs";
import { api } from "@/state/api";
import { useStoreSelector } from "@/state/store-select";
import { desktopAppVersion } from "./app-links";
import { fetchBotComputers, type BotComputerRow } from "./bot-computers";
import { companionBridge } from "./companion-bridge";
import type { CompanionState } from "./companion-types";
import { withBots } from "./device-bots";
import { buildDevices, type Device, type DeviceSources, type LentDevice, type SignedInDevice } from "./devices";
import type { PublicPhone } from "./phones";
import { isOwnerOrAdmin } from "./session";
import { readSharedSessionState } from "./shared-session";

/** How often the page reads its sources again while it is open and shown. */
export const DEVICES_POLL_MS = 5_000;

type Places = NonNullable<DeviceSources["places"]>;

export interface DevicesView {
  devices: Device[];
  companion: CompanionState | null;
  /** The phone apps registered here, for what each lets bots use. */
  phoneApps: readonly PublicPhone[];
  /** Everything has answered once (or failed): before that the map holds its space without a list. */
  loaded: boolean;
  /** Read every source again now, after an action or when an added device should be showing. */
  refresh: () => void;
}

/** Every device this place knows, read from the sources Settings already uses, again every few seconds while the page
 * is open and shown. `here`: This computer's own page in the desktop app, where the app's saved places and the phone
 * link live. `client`: this app drives another computer, which lists its own devices. */
export function useDevices({ here, client, name, kind }: { here: boolean; client: boolean; name: string; kind: DeviceSources["here"]["kind"] }): DevicesView {
  const vpsConfig = useStoreSelector((state) => state.config?.vps);
  const bots = useStoreSelector((state) => state.bots);
  const [places, setPlaces] = useState<Places | null>(null);
  const [statuses, setStatuses] = useState<ServerStatus[]>([]);
  const [lending, setLending] = useState<DeviceSources["lending"]>(null);
  const [companion, setCompanion] = useState<CompanionState | null>(null);
  const [phoneApps, setPhoneApps] = useState<PublicPhone[] | null>(null);
  const [sessions, setSessions] = useState<DeviceSources["sessions"]>(null);
  const [lent, setLent] = useState<LentDevice[] | null>(null);
  const [botRows, setBotRows] = useState<BotComputerRow[] | null>(null);
  const [answered, setAnswered] = useState(false);
  const alive = useRef(true);

  const read = useCallback(async () => {
    if (client) { setAnswered(true); return; }
    const environments = here ? window.ogb?.environments : undefined;
    const bridge = here ? companionBridge() : null;
    const session = await readSharedSessionState().catch(() => null);
    const admin = isOwnerOrAdmin(session);
    await Promise.allSettled([
      environments?.state().then((next) => { if (alive.current) setPlaces(next); }),
      environments?.status?.().then((next) => { if (alive.current) setStatuses(next); }),
      (here ? window.ogb?.computerSharing?.servers?.() : undefined)?.then((next) => { if (alive.current) setLending(next); }),
      bridge?.state().then((next) => { if (alive.current) setCompanion(next); }),
      // Phone apps and signed-in devices are admin routes: anyone else is never asked for them (a refusal every few seconds).
      admin ? api<{ phones?: PublicPhone[] }>("/api/phones", { background: true }).then((body) => { if (alive.current) setPhoneApps(body.phones ?? []); }) : undefined,
      admin ? api<{ sessions?: SignedInDevice[]; current?: string | null }>("/api/auth/sessions", { background: true })
        .then((body) => { if (alive.current) setSessions({ sessions: Array.isArray(body.sessions) ? body.sessions : [], current: typeof body.current === "string" ? body.current : null }); }) : undefined,
      // Which computer each bot works on: an admin route too, read in the background so a sleeping Cloud stays asleep.
      admin ? fetchBotComputers({ background: true })
        .then((body) => { if (alive.current) setBotRows(Array.isArray(body.rows) ? body.rows : null); }, () => { if (alive.current) setBotRows(null); }) : undefined,
      // A 404 is a place that lends no computers (the family is off for this request).
      api<{ known?: LentDevice[] }>("/api/shared-computers", { background: true })
        .then((body) => { if (alive.current) setLent(Array.isArray(body.known) ? body.known : []); }, () => { if (alive.current) setLent(null); }),
    ]);
    if (alive.current) setAnswered(true);
  }, [here, client]);

  useEffect(() => {
    alive.current = true;
    void read();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void read(); }, DEVICES_POLL_MS);
    const stop = here ? window.ogb?.environments?.onStatus?.(() => void read()) : undefined;
    return () => { alive.current = false; window.clearInterval(timer); stop?.(); };
  }, [read, here]);

  const vps = useMemo(() => {
    const servers = vpsConfig?.servers ?? [];
    const alias = vpsConfig?.sshAlias?.trim();
    return [...(alias ? [{ alias }] : []), ...servers.map((server) => ({ alias: server.sshAlias, name: server.name }))];
  }, [vpsConfig]);

  const devices = useMemo(() => withBots(buildDevices({
    here: { name, kind, version: desktopAppVersion(), desktop: typeof window !== "undefined" && Boolean(window.ogb) },
    places, statuses, lending, companion, phoneApps, sessions, lent, vps,
  }), botRows, kind, (botId) => bots.find((bot) => bot.id === botId)?.name ?? null), [name, kind, places, statuses, lending, companion, phoneApps, sessions, lent, vps, botRows, bots]);

  return { devices, companion, phoneApps: phoneApps ?? [], loaded: answered, refresh: () => void read() };
}
