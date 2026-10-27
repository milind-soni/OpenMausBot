import { useEffect, useRef, useState } from "react";
import { ChevronRight, FolderPlus, X } from "lucide-react";
import type { CloudLendingBridge, CloudLendingSnapshot, SharedFolder } from "../../electron/computer-sharing.mjs";
import { ipcErrorText, listOf } from "@/lib/cloud-send";
import { activeLocale, t } from "@/lib/i18n";
import { localizedRelativeTime } from "@/lib/memory";
import type { LocaleKey } from "@/locales";
import { LendingActivityList } from "./LendingActivity";
import { Switch } from "./SettingsPrimitives";

const PROBLEMS: Partial<Record<string, LocaleKey>> = {
  "connect-first": "lending.status.connectFirst",
  "not-cloud": "lending.status.notCloud",
  waiting: "lending.status.waiting",
  paused: "lending.status.paused",
  asleep: "lending.status.asleep",
  "signed-out": "lending.status.signedOut",
  "account-changed": "lending.status.accountChanged",
  "machine-changed": "lending.status.machineChanged",
  "access-off": "lending.status.accessOff",
};

const STOPPED: Partial<Record<string, LocaleKey>> = {
  you: "lending.stopped.you",
  "signed-out": "lending.stopped.signedOut",
  "account-changed": "lending.stopped.accountChanged",
  "machine-changed": "lending.stopped.machineChanged",
};

/** Refusals main names (electron/cloud-lending-ipc.mjs LENDING_REFUSED): trying again never helps, so no Try again. */
const REFUSED: Partial<Record<string, LocaleKey>> = {
  "home-or-root": "lending.refused.homeOrRoot",
  "not-folder": "lending.refused.notFolder",
  "too-many": "lending.refused.tooMany",
};
/** What to say when changing what is lent failed: the plain reason main named, or "Could not change … Try again." only
 * when trying again can help. */
export function lendingFailureKey(cause: unknown): LocaleKey {
  const text = ipcErrorText(cause) ?? "";
  return text.startsWith("lending-refused:") ? REFUSED[text.slice("lending-refused:".length)] ?? "lending.failed" : "lending.failed";
}

/** The words for why lending isn't working, from computer-sharing.mjs's problem code. */
export const lendingProblemKey = (code: string): LocaleKey | null => PROBLEMS[code] ?? null;

/** The word the person knows this computer by, from the app's own platform: this Mac, this PC, this computer. */
export type Device = "mac" | "pc" | "computer";
export const thisDevice = (platform = typeof window === "undefined" ? undefined : window.ogb?.platform): Device => platform === "darwin" ? "mac" : platform === "win32" ? "pc" : "computer";
const TITLE: Record<Device, LocaleKey> = { mac: "lending.title.mac", pc: "lending.title.pc", computer: "lending.title.computer" };
const LENDS: Record<Device, LocaleKey> = { mac: "lending.page.lends.mac", pc: "lending.page.lends.pc", computer: "lending.page.lends.computer" };
/** "Let my bots use this Mac". */
export const lendingTitle = (device: Device = thisDevice()) => t(TITLE[device]);
/** "Your bots can use the internet connection and Desktop, … on this Mac." */
export const lendsLine = (what: string, device: Device = thisDevice()) => t(LENDS[device], { what });

/** "the internet connection and Desktop, Documents and Downloads (read only)", or each folder with whether bots may edit
 * it, and apps and screen. */
export function lentWhat(folders: ReadonlyArray<{ name: string; write: boolean }>, screen: boolean, internet = false, terminal = false, chrome = false): string {
  const readOnly = folders.length > 0 && folders.every((folder) => !folder.write);
  const lentFolders = readOnly ? [`${listOf(folders.map((folder) => folder.name))} (${t("lending.page.readOnly")})`]
    : folders.map((folder) => folder.write ? `${folder.name} (${t("lending.page.canEdit")})` : folder.name);
  return listOf([...(internet ? [t("lending.page.internet")] : []), ...(chrome ? [t("lending.page.chrome")] : []), ...lentFolders, ...(screen ? [t("lending.cloudSide.screen")] : []), ...(terminal ? [t("lending.cloudSide.terminal")] : [])]);
}

/** Why it is off and since when, kept across restarts: an off switch never hides that it was on. */
export function lendingStoppedLine(state: CloudLendingSnapshot["state"]): string | null {
  if (!state || state.enabled || !state.stopped) return null;
  const date = new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(state.stopped.at));
  return t(STOPPED[state.stopped.reason] ?? "lending.stopped.other", { date });
}

/** What My Cloud last did here, from this computer's own record of every request. */
export function lendingLastUsedLine(snapshot: CloudLendingSnapshot | null): string | null {
  if (!snapshot?.state?.enabled && !snapshot?.activity?.length) return null;
  const last = snapshot?.activity?.find((entry) => entry.ok);
  return last ? t("lending.lastUsed", { when: localizedRelativeTime(last.at, activeLocale()) }) : t("lending.neverUsed");
}

/** "Internet connection: on" once My Cloud's browsing goes through this computer, "connecting" until then. */
export function lendingInternetKey(state: CloudLendingSnapshot["state"]): LocaleKey | null {
  if (!state?.enabled || !state.internet) return null;
  return state.link === "on" ? "lending.internetOn" : state.link === "connecting" ? "lending.internetConnecting" : null;
}

export function lendingStatusKey(snapshot: CloudLendingSnapshot | null, switchedOn: boolean): LocaleKey | null {
  const state = snapshot?.state;
  if (state?.enabled && state.problem === "access-off") return "lending.status.accessOff";
  if (state?.enabled) {
    if (state.busy) return "lending.status.busy";
    if (state.connected) return "lending.status.lent";
    return PROBLEMS[state.problem ?? ""] ?? "lending.status.starting";
  }
  if (switchedOn) return "lending.status.starting";
  return state?.problem && state.problem !== "paused" ? PROBLEMS[state.problem] ?? null : null;
}

/** Security: main picks the Cloud from the verified sign-in; nothing here names a server. `moving`: the bots are on their
 * way to My Cloud, which lends this computer once they are there unless the person turned lending off. */
export function CloudLending({ bridge, moving = false }: { bridge: CloudLendingBridge; moving?: boolean }) {
  const [snapshot, setSnapshot] = useState<CloudLendingSnapshot | null>(null);
  const [draftOn, setDraftOn] = useState(false);
  const [folders, setFolders] = useState<SharedFolder[]>([]);
  const [screen, setScreen] = useState(false);
  const [internet, setInternet] = useState(false);
  const [chrome, setChrome] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState<LocaleKey | null>(null);
  const [more, setMore] = useState(false);
  const pending = useRef(false), mounted = useRef(false);
  const accept = (next: CloudLendingSnapshot) => {
    if (!mounted.current) return;
    setSnapshot(next);
    if (!pending.current && next.state) { setFolders(next.state.folders); setScreen(next.state.screen); setInternet(next.state.internet === true); setChrome(next.state.chrome === true); setTerminal(next.state.terminal === true && next.state.via !== "access"); }  // a Computer access terminal is not carried into a choice made here
  };
  useEffect(() => {
    mounted.current = true;
    const refresh = () => void bridge.state().then(accept).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [bridge]);
  const perform = async (action: () => Promise<CloudLendingSnapshot>) => {
    if (pending.current) return;
    pending.current = true; setWorking(true); setFailed(null);
    try { const next = await action(); pending.current = false; accept(next); }
    catch (cause) { if (mounted.current) setFailed(lendingFailureKey(cause)); }
    finally { pending.current = false; if (mounted.current) setWorking(false); }
  };
  /** What is lent, as the bridge takes it: the terminal and Chrome are named only when on, so main never sees it by accident. */
  const choiceOf = (nextFolders: SharedFolder[], nextScreen: boolean, nextInternet: boolean, nextTerminal: boolean, nextChrome: boolean) =>
    ({ folders: nextFolders, screen: nextScreen, internet: nextInternet, ...(nextChrome ? { chrome: true } : {}), ...(nextTerminal ? { terminal: true } : {}) });
  const lend = (nextFolders: SharedFolder[], nextScreen: boolean, nextInternet: boolean, nextTerminal = terminal, nextChrome = chrome) => {
    setFolders(nextFolders); setScreen(nextScreen); setInternet(nextInternet); setTerminal(nextTerminal); setChrome(nextChrome);
    void perform(() => nextFolders.length || nextScreen || nextInternet || nextTerminal || nextChrome ? bridge.save(choiceOf(nextFolders, nextScreen, nextInternet, nextTerminal, nextChrome)) : bridge.stop());
  };
  /** The terminal runs any command as this person, so turning it on asks first, here and nowhere else. */
  const chooseTerminal = async (wanted: boolean) => {
    if (!wanted) { lend(folders, screen, internet, false, chrome); return; }
    const wasOn = snapshot?.state?.enabled === true || draftOn;
    if (!(await window.ogb?.confirm?.(t("lending.terminalConfirm")))) return;
    // Lending may have been stopped while the question was open, here or on My Cloud's page: a Yes given to the question
    // never starts it again. Read where it stands now and lend what is lent now, terminal added.
    const now = await bridge.state().catch(() => null);
    if (!mounted.current || !now?.state || (wasOn && now.state.enabled !== true)) return;
    accept(now);
    lend(now.state.enabled ? now.state.folders : folders, now.state.enabled ? now.state.screen : screen, now.state.enabled ? now.state.internet === true : internet, true, now.state.enabled ? now.state.chrome === true : chrome);
  };
  const enabled = snapshot?.state?.enabled === true;
  const on = enabled || draftOn;
  // Nothing chosen yet: main lends the internet connection and the usual folders, read only.
  const toggle = () => {
    if (on) { setDraftOn(false); void perform(() => bridge.stop()); return; }
    setDraftOn(true);
    // The terminal and Chrome are never carried over: after Off they have to be ticked again.
    setTerminal(false); setChrome(false);
    void perform(() => bridge.save(choiceOf(folders, screen, internet, false, false)));
  };
  if (!snapshot?.available) return null;
  const status = moving && !on && snapshot.state?.stopped?.reason !== "you" ? "lending.status.afterMove" : lendingStatusKey(snapshot, on);
  const updating = enabled && snapshot.state?.link === "unsupported";
  const chromeUpdating = enabled && snapshot.state?.chromeLink === "unsupported";
  const internetKey = lendingInternetKey(snapshot.state);
  const lent = enabled && snapshot.state?.connected && !snapshot.state.busy ? lentWhat(snapshot.state.folders, snapshot.state.screen, snapshot.state.internet === true && !updating, snapshot.state.terminal === true, snapshot.state.chrome === true && snapshot.state.chromeLink !== "unsupported") : "";
  const stopped = on ? null : lendingStoppedLine(snapshot.state);
  const lastUsed = lendingLastUsedLine(snapshot);
  const via = snapshot.state?.via === "access" ? t(snapshot.state.terminal ? "lending.viaAccessTerminal" : "lending.viaAccess") : null;
  return <div data-cloud-lending={enabled ? "on" : "off"} className="mt-2 flex w-full flex-col gap-3 border-t border-hairline/40 pt-4">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-ink">{lendingTitle()}</p>
        <p className="mt-1 text-[12px] text-ink-secondary">{t("lending.explain")}</p>
      </div>
      <Switch checked={on} disabled={working} aria-label={lendingTitle()} onClick={toggle} />
    </div>
    {status && <p role="status" className={`text-[13px] ${enabled && snapshot.state?.busy ? "font-medium text-ink" : "text-ink-secondary"}`}>{lent ? lendsLine(lent) : t(status)}</p>}
    {internetKey && <p data-lending-internet={snapshot.state?.link} className="text-[12px] text-ink-secondary">{t(internetKey)}</p>}
    {updating && <p data-lending-internet="unsupported" className="text-[12px] text-ink-secondary">{t("lending.internetUnsupported")}</p>}
    {chromeUpdating && <p data-lending-chrome="unsupported" className="text-[12px] text-ink-secondary">{t("lending.chromeUnsupported")}</p>}
    {stopped && <p data-lending-stopped={snapshot.state?.stopped?.reason} className="text-[13px] text-ink-secondary">{stopped}</p>}
    {via && <p data-lending-via="access" className="text-[12px] text-ink-secondary">{via}</p>}
    {lastUsed && <p data-lending-last-used className="text-[12px] text-ink-secondary">{lastUsed}</p>}
    {on && <button type="button" aria-expanded={more} data-lending-more className="inline-flex w-fit items-center gap-1 text-[13px] text-ink-secondary hover:text-ink" onClick={() => setMore(!more)}>
      <ChevronRight size={13} aria-hidden="true" className={more ? "rotate-90 transition-transform" : "transition-transform"} />{t("lending.more")}
    </button>}
    {on && more && <>
      <fieldset disabled={working} className="flex flex-col gap-2 disabled:opacity-60">
        <legend className="mb-1 text-[13px] font-medium text-ink">{t("lending.folders")}</legend>
        <p className="text-[12px] text-ink-secondary">{t("lending.foldersHelp")}</p>
        <p className="text-[12px] text-ink-secondary">{t("lending.drivesHelp")}</p>
        {folders.map(folder => <div key={folder.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-hairline/40 p-2">
          <div className="min-w-0 flex-1"><p className="text-[13px] text-ink">{folder.name}</p><p dir="ltr" className="break-all text-[11px] text-ink-secondary">{folder.path}</p></div>
          <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
            <input type="checkbox" checked={folder.write} onChange={event => lend(folders.map(entry => entry.id === folder.id ? { ...entry, write: event.target.checked } : entry), screen, internet)} />{t("lending.canEdit")}
          </label>
          <button type="button" aria-label={t("lending.removeFolder", { name: folder.name })} onClick={() => lend(folders.filter(entry => entry.id !== folder.id), screen, internet)} className="rounded p-1 text-ink-secondary hover:bg-control"><X size={14} /></button>
        </div>)}
        <button type="button" disabled={folders.length >= 20} onClick={() => void perform(async () => {
          const folder = await bridge.chooseFolder();
          const next = folder && !folders.some(entry => entry.path === folder.path) ? [...folders, folder] : folders;
          if (next !== folders) { setFolders(next); return bridge.save(choiceOf(next, screen, internet, terminal, chrome)); }
          return bridge.state();
        })} className="ui-button flex w-fit items-center gap-2"><FolderPlus size={14} />{t("lending.addFolder")}</button>
      </fieldset>
      <fieldset disabled={working} className="flex flex-col gap-1 disabled:opacity-60">
        <label className="flex items-start gap-2">
          <input className="mt-1" type="checkbox" checked={screen} disabled={!screen && !snapshot.screenAvailable} onChange={event => lend(folders, event.target.checked, internet)} />
          <span className="text-[13px] text-ink">{t("lending.screen")}<span className="mt-1 block text-[12px] text-ink-secondary">{t("lending.screenHelp")}</span></span>
        </label>
        {!snapshot.screenAvailable && <p className="ms-6 text-[12px] text-ink-secondary">{t("lending.screenUnavailable")}</p>}
      </fieldset>
      <fieldset disabled={working} className="flex flex-col gap-1 disabled:opacity-60">
        <label className="flex items-start gap-2">
          <input className="mt-1" type="checkbox" data-lending-internet-choice checked={internet} onChange={event => lend(folders, screen, event.target.checked)} />
          <span className="text-[13px] text-ink">{t("lending.internet")}<span className="mt-1 block text-[12px] text-ink-secondary">{t("lending.internetHelp")}</span></span>
        </label>
      </fieldset>
      <fieldset disabled={working} className="flex flex-col gap-1 disabled:opacity-60">
        <label className="flex items-start gap-2">
          <input className="mt-1" type="checkbox" data-lending-chrome-choice checked={chrome} onChange={event => lend(folders, screen, internet, terminal, event.target.checked)} />
          <span className="text-[13px] text-ink">{t("lending.chrome")}<span className="mt-1 block text-[12px] text-ink-secondary">{t("lending.chromeHelp")}</span></span>
        </label>
      </fieldset>
      <fieldset disabled={working} className="flex flex-col gap-1 disabled:opacity-60">
        <label className="flex items-start gap-2">
          <input className="mt-1" type="checkbox" data-lending-terminal-choice checked={terminal} onChange={event => void chooseTerminal(event.target.checked)} />
          <span className="text-[13px] text-ink">{t("lending.terminal")}<span className="mt-1 block text-[12px] text-ink-secondary">{t("lending.terminalHelp")}</span></span>
        </label>
      </fieldset>
      <p className="text-[12px] text-ink-secondary">{t("lending.ownConversations")}</p>
      <p className="text-[12px] text-ink-secondary">{t("lending.stopHelp")}</p>
    </>}
    {failed && <p role="alert" data-lending-failed={failed} className="text-[13px] text-danger">{t(failed)}</p>}
    {(on || (snapshot.activity?.length ?? 0) > 0) && <LendingActivityList entries={snapshot.activity ?? []} />}
  </div>;
}
