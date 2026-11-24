import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, Cloud, Laptop, Server, Smartphone } from "lucide-react";
import { productName } from "@/lib/brand";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Device, PrivateNetwork } from "@/lib/devices";
import { DESKTOP_DOWNLOAD_URL } from "../../../shared/computer-ask";
import { OwnServerLink } from "../PlaceAddSheet";
import { SettingsLinkRow, SettingsMark, SettingsRows } from "../SettingsPrimitives";
import { networkLine, networkShort } from "./device-words";
import type { SettingsShell } from "../settings/settings-shell";
import type { NetworkAction } from "./DeviceRows";
import { CommandRow, PairCodePanel, SERVER_COMMANDS } from "./PairCodePanel";
import { StatusMark } from "./device-parts";

const TAILSCALE_GET = "https://tailscale.com/download";

let pointerAt = 0, keyAt = 0;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pointerdown", () => { pointerAt = Date.now(); }, true);
  window.addEventListener("keydown", () => { keyAt = Date.now(); }, true);
}
/** Whether the last thing the person did was press a key rather than point. */
export const lastInputWasKeys = () => keyAt > pointerAt;

/** Focus on nothing, on the Settings page's own body or on its header: a key there belongs to this page. A field or menu
 * elsewhere (the Settings search, another layer) keeps its own Escape. */
export const withinPage = (element: Element | null) =>
  !element || element === document.body || Boolean(element.closest("[data-settings-page-body], [data-settings-header], [data-add-panel], [data-devices-page]"));

export type AddKind = "phone" | "computer" | "server" | "cloud";

const CARD = "settings-card relative flex flex-col gap-5 rounded-[12px] bg-menu p-4 after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_0.5px_var(--settings-edge)] after:content-['']";
const BODY = "text-[13px] leading-[18px] text-ink-secondary";

/** One numbered step: its number (a check once done), its title, and what to do under it. A step still to come is quiet. */
function Step({ n, title, state = "now", children }: { n: number; title: string; state?: "done" | "now" | "later"; children?: ReactNode }) {
  return (
    <li data-step={n} data-step-state={state} className="flex gap-3">
      <span aria-hidden="true" className={cn("flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium leading-none tabular-nums",
        state === "done" ? "bg-success" : state === "now" ? "bg-ink text-app" : "shadow-[inset_0_0_0_1px_var(--settings-edge)] text-ink-tertiary")}>
        {state === "done" ? <Check size={12} strokeWidth={2.5} /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className={cn("text-[13px] font-medium leading-5 [text-wrap-style:auto]!", state === "later" ? "text-ink-tertiary" : "text-ink")}>
          <span className="sr-only">{t("devicesPage.addFlow.stepOf", { n })}</span>{title}
        </span>
        {state !== "later" && children}
      </div>
    </li>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="flex flex-col gap-5">{children}</ol>;
}

/** Under the step's own why, the next step alone: what Tailscale is was said once already. */
const stepLine = (network: PrivateNetwork) => (network.state === "unknown" ? t("devicesPage.network.line.setUpChecks")
  : network.state === "not-installed" ? t("devicesPage.network.line.notInstalled") : networkLine(network));

/** The private network's state and its one button, as a step of adding a computer. */
function NetworkStep({ network, action, waiting, onCheck, checking }: { network: PrivateNetwork; action: NetworkAction | null; waiting: boolean; onCheck?: () => void; checking: boolean }) {
  return (
    <div data-add-network={waiting ? "waiting" : network.state} className="flex flex-col items-start gap-2">
      <span className="flex items-center gap-1.5 text-[13px] leading-[18px] text-ink"><StatusMark status={network.state === "ready" ? "online" : network.state === "unknown" ? "unknown" : "attention"} />{networkShort(network)}</span>
      <span className={BODY}>{waiting ? t("devices.computers.waiting", { app: productName() }) : stepLine(network)}</span>
      <span className="flex flex-wrap items-center gap-2">
        {action && (action.href
          ? <a href={action.href} target="_blank" rel="noreferrer" className="ui-button ui-button-sm" data-network-action="">{action.label}</a>
          : <button type="button" className="ui-button ui-button-sm" data-network-action="" disabled={action.busy} onClick={action.run}>{action.label}</button>)}
        {action?.href && onCheck && <button type="button" className="settings-quiet cursor-pointer" disabled={checking} onClick={onCheck}>{checking ? t("common.checking") : t("remote.checkAgain")}</button>}
      </span>
    </div>
  );
}

/** A device that joined while this panel was open: the confirmation, and Done back to the list with it open. */
function Connected({ device, onDone }: { device: Device; onDone: (id: string) => void }) {
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => { done.current?.focus(); }, []);
  return (
    <div role="status" data-add-connected={device.id} className="flex flex-col items-start gap-3">
      <span className="flex items-center gap-2 text-[14px] font-medium leading-5 text-ink">
        <span aria-hidden="true" className="flex size-5 items-center justify-center rounded-full bg-success"><Check size={12} strokeWidth={2.5} /></span>
        {t("devicesPage.addFlow.connected", { name: device.name })}
      </span>
      <p className={BODY}>{t("devicesPage.addFlow.connectedLine")}</p>
      <button ref={done} type="button" data-add-done="" className="ui-button ui-button-primary" onClick={() => onDone(device.id)}>{t("devices.pair.done")}</button>
    </div>
  );
}

const GROUP_OF: Record<AddKind, (device: Device) => boolean> = {
  phone: (device) => device.kind === "phone",
  computer: (device) => device.kind === "laptop" || device.kind === "desktop",
  server: (device) => device.kind === "server" || device.kind === "desktop",
  cloud: (device) => device.kind === "cloud",
};

export interface AddDeviceProps {
  /** This computer's own page in the desktop app. */
  here: boolean;
  /** A MausBot Cloud's page: another computer opens it by signing in, with no code. */
  cloud: boolean;
  devices: readonly Device[];
  /** Every source has answered at least once. */
  loaded: boolean;
  network: PrivateNetwork | null;
  networkAction: NetworkAction | null;
  /** Where another computer on the private network opens this one. */
  tailnetAddress: string | null;
  start: AddKind | null;
  /** Back to the list; with an id, that new device's row opens. */
  onBack: (opened?: string) => void;
  onConnected: () => void;
  /** On This computer: its own steps for a phone, shown here in place of a code. */
  phoneSteps: ReactNode | null;
  /** Advanced mode: a Cloud's or server's phone code may be for chat and approvals only. */
  advanced?: boolean;
  canConnectServer: boolean;
  onGetCloud: (() => void) | null;
  onCheck?: () => void;
  checking?: boolean;
  /** A phone-narrow window: its header names this step and goes back, so the page leaves out its own. */
  setSub?: SettingsShell["setSub"];
  /** Opened from the keyboard. */
  viaKeys?: boolean;
}

/**
 * Add a device, in the page: what kind, then that kind's few steps, numbered, with the next one always in view, and a
 * confirmation once the new device shows up. Back (or Escape) goes up one step and then to the list. Nothing opens over
 * Settings: a phone on This computer gets its own steps, a server Connect to another computer's own form.
 */
export function AddDevicePanel(props: AddDeviceProps) {
  const { here, cloud, devices, network, networkAction, tailnetAddress, start, onBack, onConnected, phoneSteps, canConnectServer, onGetCloud, onCheck, checking = false, setSub } = props;
  const [kind, setKind] = useState<AddKind | null>(start);
  // The devices there before this step, read once every source has answered: one that joins after is the new one.
  const [known, setKnown] = useState<ReadonlySet<string> | null>(() => (props.loaded ? new Set(devices.map((device) => device.id)) : null));
  useEffect(() => { if (props.loaded && !known) setKnown(new Set(devices.map((device) => device.id))); }, [props.loaded, known, devices]);
  const heading = useRef<HTMLDivElement>(null);
  const left = useRef<AddKind | null>(null);
  // Keys move focus to the step's first control; a pointer leaves it on the step itself, with no ring.
  const keys = useRef(props.viaKeys ?? false);
  const choose = (next: AddKind) => { keys.current = lastInputWasKeys(); setKind(next); };
  // Into a step, focus goes to its heading; back on the choices, to the choice just left.
  useEffect(() => {
    const panel = heading.current?.parentElement;
    const chosen = !kind && left.current ? panel?.querySelector<HTMLElement>(`[data-add-kind="${left.current}"]`) : null;
    const first = kind && keys.current ? panel?.querySelector<HTMLElement>("[data-add-card] :is(button:not([disabled]), a[href], input:not([disabled]))") : null;
    document.querySelector("[data-settings-scroll]")?.scrollTo?.({ top: 0 });
    (chosen ?? first ?? heading.current)?.focus({ preventScroll: true });
  }, [kind]);
  const back = () => {
    if (kind && !start) { left.current = kind; setKind(null); return; }
    onBack();
  };
  const backTo = kind && !start ? t("devicesPage.add") : t("settings.page.devices");
  const joined = kind && known ? devices.find((device) => !known.has(device.id) && GROUP_OF[kind](device)) : undefined;
  const shared = network?.state === "ready" && network.shared;
  const networkReady = Boolean(shared && tailnetAddress);
  // On and shared, but nothing answers at the address yet: the step is to check again.
  const stepAction: NetworkAction | null = shared && !tailnetAddress ? (onCheck ? { label: t("remote.checkAgain"), run: onCheck, busy: checking } : null) : networkAction;
  const title = kind ? t(TITLE[kind]) : t("devicesPage.add");
  const lede = kind ? t(LEDE[kind], { app: productName() }) : t("devicesPage.addFlow.chooseLede");
  const backRef = useRef(back);
  backRef.current = back;
  // Escape steps back wherever focus is in this page or its header (or nowhere, after a step swapped), never past it.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !withinPage(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      backRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  useEffect(() => {
    setSub?.({ title, back: backTo, onBack: () => backRef.current() });
  }, [setSub, title, backTo]);
  useEffect(() => () => setSub?.(null), [setSub]);
  return (
    <div data-add-panel="" data-add-step={kind ?? "choose"} className="flex flex-col gap-4">
      <div ref={heading} tabIndex={-1} role="group" aria-label={title} className="flex flex-col gap-1 px-4 outline-none!">
        {!setSub && <>
          <button type="button" data-add-back="" onClick={back} aria-label={kind && !start ? t("devicesPage.addFlow.backToChoose") : t("devicesPage.addFlow.backToList")}
            className="-ms-1.5 inline-flex h-7 w-fit cursor-pointer items-center gap-0.5 rounded-full pe-2 ps-1 text-[13px] font-medium leading-5 text-ink-secondary hover:bg-ink/[0.05] hover:text-ink">
            <ChevronLeft size={16} aria-hidden="true" className="rtl:-scale-x-100" />{backTo}
          </button>
          <h3 data-add-title="" className="text-[17px] font-semibold leading-6 tracking-[-0.01em] text-ink">{title}</h3>
        </>}
        <p className={BODY}>{lede}</p>
      </div>
      {!kind && (
        <SettingsRows icons>
          <SettingsLinkRow leading={<SettingsMark><Smartphone /></SettingsMark>} title={t("devicesPage.add.phone")} subtitle={t("devicesPage.add.phoneLine", { app: productName() })} onClick={() => choose("phone")} data={{ "data-add-kind": "phone" }} />
          <SettingsLinkRow leading={<SettingsMark><Laptop /></SettingsMark>} title={t("devicesPage.add.computer")} subtitle={t("devicesPage.add.computerLine")} onClick={() => choose("computer")} data={{ "data-add-kind": "computer" }} />
          <SettingsLinkRow leading={<SettingsMark><Server /></SettingsMark>} title={t("devicesPage.add.server")} subtitle={t("devicesPage.add.serverLine")} onClick={() => choose("server")} data={{ "data-add-kind": "server" }} />
          {onGetCloud && <SettingsLinkRow leading={<SettingsMark><Cloud /></SettingsMark>} title={t("devicesPage.add.cloud")} subtitle={t("devicesPage.add.cloudAlwaysOn")} onClick={() => choose("cloud")} data={{ "data-add-kind": "cloud" }} />}
        </SettingsRows>
      )}
      {kind && (
        <div data-add-card="" className={CARD}>
          {joined ? <Connected device={joined} onDone={(id) => onBack(id)} /> : <>
            {kind === "phone" && (phoneSteps ?? <PairCodePanel kind="phone" address={null} onConnected={onConnected} cloudHome={cloud} advanced={props.advanced} />)}
            {kind === "computer" && (cloud
              ? <p className={BODY}>{t("devicesPage.addFlow.computerCloud", { app: productName() })}</p>
              : <Steps>
                {here && network && <Step n={1} title={t("devicesPage.addFlow.networkFirst")} state={networkReady ? "done" : "now"}>
                  {!networkReady && <>
                    <p data-add-network-why="" className={BODY}>{t("devicesPage.addFlow.networkWhy", { app: productName() })}</p>
                    <NetworkStep network={network} action={stepAction} waiting={Boolean(shared && !tailnetAddress)} onCheck={onCheck} checking={checking} />
                  </>}
                </Step>}
                <Step n={here && network ? 2 : 1} title={t(here && network ? "devicesPage.addFlow.installBoth" : "devicesPage.addFlow.installStep", { app: productName() })} state={!here || networkReady ? "now" : "later"}>
                  {here && network && <p className={BODY}>{t("devicesPage.addFlow.installBothLine")}</p>}
                  <span className="flex flex-wrap gap-2">
                    <a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer" className="ui-button ui-button-sm w-fit">{t("computerAsk.action.getApp", { app: productName() })}</a>
                    {here && network && <a href={TAILSCALE_GET} target="_blank" rel="noreferrer" className="ui-button ui-button-sm w-fit">{t("remote.tailscale.getIt")}</a>}
                  </span>
                </Step>
                <Step n={here && network ? 3 : 2} title={t("devicesPage.addFlow.pasteStep")} state={!here || networkReady ? "now" : "later"}>
                  <PairCodePanel kind="computer" address={tailnetAddress} onConnected={onConnected} />
                </Step>
              </Steps>)}
            {kind === "server" && <Steps>
              <Step n={1} title={t("devicesPage.addFlow.serverRunTerminal")}>
                <CommandRow label={t("devicesPage.addFlow.serverAnywhere")} command={SERVER_COMMANDS.anywhere} />
                <CommandRow label={t("devicesPage.addFlow.serverPrivate")} command={SERVER_COMMANDS.tailscale} />
                <p className="text-[12px] leading-4 text-ink-secondary">{t("devicesPage.addFlow.serverHow")}</p>
              </Step>
              <Step n={2} title={t("devicesPage.addFlow.pasteLink")}>
                {canConnectServer
                  ? <OwnServerLink inline onBack={null} onConnected={onConnected} />
                  : <p className={BODY}>{t("devicesPage.addFlow.serverDesktopOther", { app: productName() })}</p>}
              </Step>
            </Steps>}
            {kind === "cloud" && onGetCloud && (
              <div className="flex flex-col items-start gap-3">
                <p className={BODY}>{t("devicesPage.addFlow.cloudLine", { app: productName() })}</p>
                <button type="button" data-get-cloud="" className="ui-button ui-button-primary" onClick={onGetCloud}>{t("devicesPage.addFlow.seePlans")}</button>
                <p className="text-[12px] leading-4 text-ink-tertiary">{t("devicesPage.addFlow.cloudLeaves")}</p>
              </div>
            )}
          </>}
        </div>
      )}
    </div>
  );
}

const TITLE = { phone: "devicesPage.add.phoneTitle", computer: "devicesPage.add.computerTitle", server: "devicesPage.add.serverTitle", cloud: "devicesPage.add.cloudAdd" } as const;
const LEDE = { phone: "devicesPage.addFlow.phoneLede", computer: "devicesPage.addFlow.computerLede", server: "devicesPage.addFlow.serverLede", cloud: "devicesPage.addFlow.cloudLede" } as const;
