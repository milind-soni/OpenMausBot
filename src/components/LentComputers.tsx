import { useEffect, useState } from "react";
import { Laptop } from "lucide-react";

import type { PageLending } from "../../electron/cloud-lending-ipc.mjs";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { localizedRelativeTime } from "@/lib/memory";
import { api } from "@/state/store";
import { lendingFailureKey, lendingProblemKey, lendingTitle, lendsLine, lentWhat } from "./CloudLending";
import { Card, Switch } from "./SettingsPrimitives";

/** A computer lent to this server, now or before (server/shared-computers.ts KnownLentComputer). */
export interface KnownLentComputer {
  id: string;
  name: string;
  platform: "darwin" | "win32" | "linux" | null;
  online: boolean;
  busy: boolean;
  lent: boolean;
  lastSeenAt: number;
  lastUsedAt: number | null;
  scopes: { folders: number; terminal: boolean; screen: boolean; internet?: boolean; chrome?: boolean };
}

const PLATFORM: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

export function lentComputerLines(computer: KnownLentComputer, now = Date.now()): string[] {
  const state = !computer.lent ? t("lending.cloudSide.stopped", { when: localizedRelativeTime(computer.lastSeenAt, activeLocale(), now) })
    : computer.busy ? t("lending.cloudSide.busy")
    : computer.online ? t("lending.cloudSide.online")
    : t("lending.cloudSide.offline", { when: localizedRelativeTime(computer.lastSeenAt, activeLocale(), now) });
  const what = [
    ...(computer.scopes.internet ? [t("lending.cloudSide.internet")] : []),
    ...(computer.scopes.chrome ? [t("lending.cloudSide.chrome")] : []),
    ...(computer.scopes.folders === 1 ? [t("lending.cloudSide.folderOne")]
      : computer.scopes.folders ? [t("lending.cloudSide.folders", { count: String(computer.scopes.folders) })] : []),
    ...(computer.scopes.screen ? [t("lending.cloudSide.screen")] : []),
    ...(computer.scopes.terminal ? [t("lending.cloudSide.terminal")] : []),
  ];
  const away = computer.lent && !computer.online && computer.scopes.internet === true;
  return [state, ...(computer.lent && what.length ? [t("lending.cloudSide.lends", { what: what.join(", ") })] : []),
    ...(away ? [t("lending.cloudSide.internetAway")] : []),
    computer.lastUsedAt ? t("lending.cloudSide.lastUsed", { when: localizedRelativeTime(computer.lastUsedAt, activeLocale(), now) }) : t("lending.cloudSide.neverUsed")];
}

/** The one line under the switch: what My Cloud can use here, how it's going, or that it's off. */
export function pageLendingLine(lending: PageLending): string {
  if (!lending.on) return t("lending.page.off");
  if (lending.status === "busy") return t("lending.status.busy");
  if (lending.status && lending.status !== "lent" && lending.status !== "starting") return t(lendingProblemKey(lending.status) ?? "lending.status.starting");
  if (lending.status === "starting") return t("lending.status.starting");
  const updating = lending.link === "unsupported";
  const what = lentWhat(lending.folders, lending.screen, lending.internet === true && !updating, lending.terminal === true, lending.chrome === true && !updating);
  if (updating) return what ? `${lendsLine(what)} ${t("lending.internetUnsupported")}` : t("lending.internetUnsupported");
  const line = what ? lendsLine(what) : t("lending.status.lent");
  return lending.internet && lending.link === "connecting" ? `${line} ${t("lending.internetConnecting")}` : line;
}

type PageLendingBridge = { state(): Promise<PageLending>; set(on: boolean): Promise<PageLending>; screen?(on: boolean): Promise<PageLending>; terminal?(on: boolean): Promise<PageLending> };

/** In the desktop app on My Cloud's own page: "Let my bots use this Mac" right here, one switch, one line, Apps and
 * screen and the terminal, so nobody has to leave My Cloud. Turning any on takes a real click; Apps and screen and the
 * terminal also ask in a dialog of this app's own. */
function LendThisComputer({ bridge }: { bridge: PageLendingBridge }) {
  const [lending, setLending] = useState<PageLending | null>(null);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState<LocaleKey | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => void bridge.state().then((next) => { if (alive) setLending(next); }).catch(() => {});
    read();
    const timer = setInterval(read, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [bridge]);
  if (!lending?.available) return null;
  const perform = (action: () => Promise<PageLending>) => {
    setWorking(true); setFailed(null);
    void action().then(setLending).catch((cause: unknown) => setFailed(lendingFailureKey(cause))).finally(() => setWorking(false));
  };
  const toggle = () => perform(() => bridge.set(!lending.on));
  const lendScreen = bridge.screen;
  const lendTerminal = bridge.terminal;
  return <div data-lend-this-computer={lending.on ? "on" : "off"} className="flex flex-col gap-1.5 rounded-lg bg-raised/60 p-3">
    <div className="flex items-start justify-between gap-3">
      <p id="lend-this-computer" className="text-[13px] font-medium text-ink">{lendingTitle()}</p>
      <Switch checked={lending.on} disabled={working} aria-labelledby="lend-this-computer" onClick={toggle} />
    </div>
    <p role="status" className="text-[13px] text-ink-secondary">{pageLendingLine(lending)}</p>
    {lending.on && lendScreen && <label data-lend-screen={lending.screen ? "on" : "off"} className="mt-1 flex items-start gap-2">
      <input className="mt-1" type="checkbox" checked={lending.screen} disabled={working || (!lending.screen && !lending.screenAvailable)}
        onChange={(event) => perform(() => lendScreen(event.target.checked))} />
      <span className="text-[13px] text-ink">{t("lending.screen")}<span className="mt-0.5 block text-[12px] text-ink-secondary">
        {t(lending.screen || lending.screenAvailable ? "lending.screenHelp" : "lending.screenUnavailable")}</span></span>
    </label>}
    {lending.on && lendTerminal && <label data-lend-terminal={lending.terminal ? "on" : "off"} className="mt-1 flex items-start gap-2">
      <input className="mt-1" type="checkbox" checked={lending.terminal === true} disabled={working}
        onChange={(event) => perform(() => lendTerminal(event.target.checked))} />
      <span className="text-[13px] text-ink">{t("lending.terminal")}<span className="mt-0.5 block text-[12px] text-ink-secondary">
        {t("lending.terminalHelp")}</span></span>
    </label>}
    {failed && <p role="alert" data-lending-failed={failed} className="text-[13px] text-danger">{t(failed)}</p>}
  </div>;
}

/** My Cloud's own page: this computer's lending switch (in the desktop app), then each computer lent to it, whether it is
 * online or since when not, what it lends and when My Cloud last used it. */
export function LentComputersCard() {
  const [known, setKnown] = useState<KnownLentComputer[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    // The 15-second poll never wakes a Cloud home that went to sleep.
    const load = (background = false) => api<{ known?: KnownLentComputer[] }>("/api/shared-computers", background ? { background } : undefined)
      .then((answer) => { if (alive) { setKnown(answer.known ?? []); setFailed(false); } })
      .catch(() => { if (alive) setFailed(true); });
    void load();
    const timer = setInterval(() => void load(true), 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const lending = window.ogb?.cloudLending;
  const here = lending?.state && lending.set ? { state: lending.state, set: lending.set, screen: lending.screen, terminal: lending.terminal } : null;
  return <Card title={t("lending.cloudSide.title")}>
    <div data-lent-computers={known === null ? "loading" : known.length} className="flex flex-col gap-3">
      {here && <LendThisComputer bridge={here} />}
      {failed && <p role="alert" className="text-[13px] text-danger">{t("lending.cloudSide.error")}</p>}
      {known?.length === 0 && <p className="text-[13px] text-ink-secondary">{t("lending.cloudSide.empty")}</p>}
      {!!known?.length && <ul className="divide-y divide-hairline/40">
        {known.map((computer) => <li key={computer.id} data-lent-computer={computer.online ? "online" : computer.lent ? "offline" : "stopped"} className="flex items-start gap-2 py-2.5">
          <Laptop size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-secondary" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-ink">{computer.name}{computer.platform ? <span className="font-normal text-ink-secondary"> · {PLATFORM[computer.platform]}</span> : null}</p>
            {lentComputerLines(computer).map((line) => <p key={line} className="text-[12px] text-ink-secondary">{line}</p>)}
          </div>
        </li>)}
      </ul>}
    </div>
  </Card>;
}
