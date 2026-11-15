import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { t } from "@/lib/i18n";
import { copyText, type CopyFeedback } from "@/lib/copy-text";
import { api } from "@/state/store";
import { isOwnerOrAdmin, readSessionState, type SessionState } from "../lib/session";
import { readMembership } from "../lib/membership";
import { codeUntil, lastSeen } from "../lib/pairing-time";
import { revealPhonePairing, takePairOnOpen } from "../lib/phone-pairing";
import { SettingsGroup, SettingsRows, Switch } from "./SettingsPrimitives";
import { Layer } from "./Layer";
import { DialogTitle, PairRow } from "./PhoneDevicesSection";
import { Smartphone } from "lucide-react";
import { productName } from "@/lib/brand";
import { Select } from "./Select";
import { cn } from "@/lib/cn";
import { TeamPhoneCard } from "./TeamPhoneCard";
import type { DeviceView } from "../../shared/device-view";
import { EMPTY_VIEW, flipTarget, knownTargets, NO_TARGETS, pairingBody, pickedCount, switchTargets, togglePicked, viewNames, viewTargetsFrom, type DeviceAccess, type DeviceViewTargets } from "../lib/device-view-choice";
import { ComputerNameRow } from "./ComputerNameRow";
import { isPrivateHost, serverTransport } from "../../electron/server-address.mjs";

export interface PairingOffer {
  id: string;
  code: string;
  expiresAt: number;
  url: string | null;
  hint: string | null;
  /** False when this server has no phone key, so a paired phone cannot enter secrets here. Absent on older servers. */
  phoneSecrets?: boolean;
}

export interface PairedDevice {
  id: string;
  label: string;
  scopes: string[];
  lastSeenAt: number;
  expiresAt: number;
  email?: string;
  view?: DeviceView;
}

/**
 * Security: only the owner on its own machine or an admin session may pair; a chat-only session must not even see the
 * offer.
 */
export function canPairDevices(state: SessionState | null): boolean {
  return isOwnerOrAdmin(state);
}

export function pairingBlockedReason(state: SessionState | null): "chat-only" | null {
  return state?.kind === "session" && !state.scopes.includes("admin") ? "chat-only" : null;
}

/** The line a pairing code shows when the phone will not be able to enter secrets on this server. */
export function phoneSecretNote(offer: Pick<PairingOffer, "phoneSecrets">): string | null {
  return offer.phoneSecrets === false ? t("remote.serverPairing.noPhoneSecrets") : null;
}

/** True when a pairing link is a plain http address on a home network: a phone away from that Wi-Fi cannot open it.
 * Tailscale addresses (100.64/10, fd7a:115c:a1e0::/48, `*.ts.net`) work from anywhere on the tailnet, so they get no note. */
export function sameWifiOnlyLink(url: string | null): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    if (serverTransport(url) !== "private-http" || !isPrivateHost(hostname)) return false;
    const [a, b] = hostname.split(".").map(Number);
    return !(a === 100 && b >= 64 && b <= 127) && !hostname.startsWith("[fd7a:115c:a1e0:");
  } catch {
    return false;
  }
}

export function shownDevices(devices: PairedDevice[], cloudHome: boolean): PairedDevice[] {
  return cloudHome ? devices.filter((device) => device.scopes.includes("admin")) : devices;
}


const quiet = "ui-button";

export function ViewTargetPicker({ targets, picked, onToggle, saving = false }: { targets: DeviceViewTargets; picked: DeviceView; onToggle: (kind: keyof DeviceView, id: string) => void; saving?: boolean }) {
  const kinds: Array<{ kind: keyof DeviceView; label: string; items: Array<{ id: string; name: string }> }> = [
    { kind: "sections", label: t("remote.serverPairing.view.department"), items: targets.sections.map((section) => ({ id: section, name: section.trim() || t("remote.serverPairing.view.general") })) },
    { kind: "bots", label: t("remote.serverPairing.view.bot"), items: switchTargets(targets, picked, "bots") },
    { kind: "groups", label: t("remote.serverPairing.view.group"), items: switchTargets(targets, picked, "groups") },
  ];
  return (
    <div data-device-view-picker className="flex flex-wrap gap-x-8 gap-y-3 text-[13px]">
      {kinds.filter(({ items }) => items.length).map(({ kind, label, items }) => (
        <fieldset key={kind} className="min-w-[12rem]">
          <legend className="mb-1 font-medium text-ink">{label}</legend>
          {items.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 py-1 text-ink">
              <span className="truncate">{item.name}</span>
              <Switch checked={picked[kind].includes(item.id)} aria-label={item.name} disabled={saving} onClick={() => onToggle(kind, item.id)} />
            </div>
          ))}
        </fieldset>
      ))}
      {targets.groups.length ? <p className="basis-full text-[12px] text-ink-secondary">{t("remote.serverPairing.view.roomNote")}</p> : null}
    </div>
  );
}

export function deviceAccessName(device: Pick<PairedDevice, "scopes" | "view">, targets: DeviceViewTargets): string {
  if (!device.view) return t(device.scopes.includes("admin") ? "remote.serverPairing.scope.admin" : "remote.serverPairing.scope.client");
  const names = viewNames(device.view, targets, t("remote.serverPairing.view.general"));
  if (!pickedCount(device.view)) return t("remote.serverPairing.view.nothing");
  if (!names.length) return t("remote.serverPairing.view.gone");
  const shown = names.slice(0, 2).join(", ");
  return t("remote.serverPairing.view.only", { names: names.length > 2 ? t("remote.serverPairing.view.more", { names: shown, count: names.length - 2 }) : shown });
}

/** Limiting a full-access device takes its admin away, and lifting the limit never gives it back. */
export function limitWarning(device: Pick<PairedDevice, "scopes" | "view">): string | null {
  return device.scopes.includes("admin") && !device.view ? t("remote.serverPairing.view.dropsAdmin") : null;
}

export function ServerPairingCard({ initialSession = null, initialPairingCodes = true, cloudHome = false, focusRequest = 0, team, teamPhoneBlocked = null, simple = false, reveal = true, placeName = "" }: { placeName?: string; initialSession?: SessionState | null; initialPairingCodes?: boolean; cloudHome?: boolean; focusRequest?: number; team?: string; teamPhoneBlocked?: string | null; simple?: boolean; /** False where another pairing flow owns the page's focus. */ reveal?: boolean }) {
  const [session, setSession] = useState<SessionState | null>(initialSession);
  const [pairingCodes, setPairingCodes] = useState(initialPairingCodes);
  const [access, setAccess] = useState<DeviceAccess>("admin");
  const [picked, setPicked] = useState<DeviceView>(EMPTY_VIEW);
  const [editing, setEditing] = useState<{ id: string; picked: DeviceView; saving?: boolean } | null>(null);
  const savingView = useRef(false);
  const [targets, setTargets] = useState<DeviceViewTargets>(NO_TARGETS);
  const [computerName, setComputerName] = useState<string | null>(null);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<CopyFeedback>("idle");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  const revealed = useRef(0);

  async function loadDevices() {
    try {
      const body = await api("/api/auth/sessions");
      setDevices(Array.isArray(body?.sessions) ? body.sessions : []);
      setCurrent(typeof body?.current === "string" ? body.current : null);
      setTargets(viewTargetsFrom(await api("/api/bots?messages=0")));
    } catch (e) {
      setError(t("remote.serverPairing.error", { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  useEffect(() => {
    void readSessionState().then((state) => {
      setSession(state);
      if (canPairDevices(state)) void loadDevices();
      if (state.kind === "loopback" || state.kind === "session") {
        void api("/api/config").then((config) => {
          setPairingCodes(readMembership(config).pairingCodes);
          if (canPairDevices(state)) setComputerName(typeof config?.computerName === "string" ? config.computerName : "");
        }).catch(() => {});
      }
    });
  }, []);

  useEffect(() => {
    if (!focusRequest) revealed.current = 0;
    else if (revealed.current !== focusRequest && revealPhonePairing(root.current)) {
      revealed.current = focusRequest;
      if (canPairDevices(session) && takePairOnOpen()) void create();
    }
  }, [focusRequest, session]);

  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [offer]);

  if (team && session?.kind === "session" && session.team) {
    return (
      <div ref={root} tabIndex={-1} data-phone-pairing="server" className="scroll-mt-4 rounded-xl focus:outline-none">
        <TeamPhoneCard team={team} blocked={teamPhoneBlocked} />
      </div>
    );
  }
  if (!canPairDevices(session)) {
    if (pairingBlockedReason(session) !== "chat-only") return null;
    const reason = t(pairingCodes ? "remote.serverPairing.chatOnlyShort" : "remote.serverPairing.portalChatOnly");
    return (
      <div ref={root} tabIndex={-1} data-phone-pairing="server" className="flex scroll-mt-4 flex-col gap-6 focus:outline-none">
        <SettingsGroup block="pair">
          <SettingsRows>
            <PairRow reason={reason}>
              <button type="button" aria-disabled="true" data-phone-pairing-action={reveal ? "" : undefined} data-settings-drop="" title={reason} className="ui-button ui-button-primary opacity-40">{t("phone.pair.button")}</button>
            </PairRow>
          </SettingsRows>
          <p data-server-pairing-chat-only className="px-4 text-[12px] leading-4 text-ink-secondary">{t(pairingCodes ? "remote.serverPairing.chatOnly" : "remote.serverPairing.portalChatOnly")}</p>
        </SettingsGroup>
      </div>
    );
  }
  const expired = offer ? offer.expiresAt <= now : false;
  const listed = shownDevices(devices, cloudHome);

  async function create() {
    setBusy(true);
    setError(null);
    setCopied("idle");
    try {
      const body: PairingOffer = await api("/api/auth/pairing", { method: "POST", body: JSON.stringify(pairingBody(cloudHome ? "admin" : access, knownTargets(picked, targets))) });
      setOffer(body);
      setNow(Date.now());
    } catch (e) {
      setError(t("remote.serverPairing.error", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function signOut(id: string) {
    setError(null);
    try {
      await api(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadDevices();
    } catch (e) {
      setError(t("remote.serverPairing.error", { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  /** The device's stored view after the change (undefined once its limit is lifted), or false when it failed. */
  async function changeView(id: string, view: DeviceView | null): Promise<DeviceView | undefined | false> {
    setError(null);
    try {
      const changed: { session?: Pick<PairedDevice, "view"> } = await api(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ view }) });
      await loadDevices();
      return changed.session?.view;
    } catch (e) {
      setError(t("remote.serverPairing.error", { error: e instanceof Error ? e.message : String(e) }));
      // A target deleted meanwhile is refused; reloading drops it, so the next change can be saved.
      await loadDevices();
      return false;
    }
  }

  async function unlimit(device: PairedDevice) {
    if (savingView.current) return;
    savingView.current = true;
    setEditing((open) => open?.id === device.id ? { ...open, saving: true } : open);
    const stored = await changeView(device.id, null);
    savingView.current = false;
    setEditing((open) => open?.id !== device.id ? open : stored === false ? { ...open, saving: false } : null);
  }

  async function flip(device: PairedDevice, before: DeviceView, kind: keyof DeviceView, id: string) {
    // A ref, not state: a second click in the same frame still sees the first one's `before`.
    if (savingView.current) return;
    savingView.current = true;
    const next = flipTarget(before, kind, id, targets);
    setEditing({ id: device.id, picked: next, saving: true });
    const stored = await changeView(device.id, next);
    savingView.current = false;
    setEditing((open) => open?.id === device.id ? { id: device.id, picked: stored === false ? before : stored ?? next } : open);
  }

  async function copyLink() {
    if (!offer?.url) return;
    const result = await copyText(offer.url);
    if (result !== "empty") setCopied(result);
  }

  const secretNote = offer ? phoneSecretNote(offer) : null;
  const sameWifiOnly = sameWifiOnlyLink(offer?.url ?? null);
  const offerPanel = pairingCodes && offer ? (
    <Layer modal>
      <div role="dialog" aria-modal="true" aria-label={t("phone.pair.dialogTitle", { place: placeName })} data-settings-look="simple" data-pair-dialog="code"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={(event) => event.target === event.currentTarget && setOffer(null)}>
        <div className="relative flex max-h-full w-full max-w-[440px] flex-col gap-4 overflow-y-auto rounded-2xl border-[0.5px] border-(--settings-edge) bg-app p-6 shadow-xl">
          <DialogTitle title={t("phone.pair.dialogTitle", { place: placeName })} onClose={() => setOffer(null)} />
          {expired ? (
            <p className="text-[13px] leading-[18px] text-ink-secondary">{t("remote.serverPairing.expired")}</p>
          ) : (
            <div className="flex flex-col items-start gap-4">
              {/* The code is the dialog's centre: the QR sits in the middle, and the words under it run the full width. */}
              {offer.url ? (
                <div data-pair-qr="" className="self-center rounded-[12px] bg-white p-3 shadow-[inset_0_0_0_0.5px_var(--settings-edge)]">
                  <QRCodeSVG value={offer.url} size={200} level="M" bgColor="#ffffff" fgColor="#111111" />
                </div>
              ) : null}
              {/* One 14/20 ink instruction, then 12/16 secondary notes. */}
              <div className="flex flex-col gap-1" data-pair-instructions="">
                {offer.url ? <>
                  <p className="text-[14px] leading-5 text-ink">{t("phone.code.installAndScan", { app: productName() })}</p>
                  <p className="text-[12px] leading-4 text-ink-secondary">{t("phone.code.notCamera", { app: productName() })}</p>
                </> : <p className="text-[14px] leading-5 text-ink">{t("phone.code.typeThis", { app: productName() })}</p>}
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-[20px] font-medium leading-7 tracking-[0.08em] text-ink tabular-nums" data-pairing-code="">{offer.code}</div>
                <div className="text-[12px] leading-4 text-ink-secondary">{codeUntil(offer.expiresAt)}</div>
              </div>
              <p className="text-[12px] leading-4 text-ink-secondary">{t(cloudHome ? "phone.pair.cloudPersonal" : "remote.serverPairing.subtitle", { app: productName() })}</p>
              {secretNote ? <p data-pair-no-phone-secrets="" className="text-[12px] leading-4 text-ink-secondary">{secretNote}</p> : null}
              {sameWifiOnly ? <p data-pair-same-wifi="" className="text-[12px] leading-4 text-ink-secondary">{t("remote.serverPairing.sameWifiOnly", { app: productName() })}</p> : null}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            {!expired && offer.url && (
              <button type="button" onClick={() => void copyLink()} className="ui-button mr-auto">
                {t(copied === "copied" ? "remote.serverPairing.copied" : copied === "failed" ? "common.copyFailed" : "remote.serverPairing.copyLink")}
              </button>
            )}
            {expired && <button type="button" className="ui-button" onClick={() => void create()}>{t("remote.serverPairing.create")}</button>}
            <button type="button" className="ui-button ui-button-primary" onClick={() => setOffer(null)}>{t("devices.pair.done")}</button>
          </div>
        </div>
      </div>
    </Layer>
  ) : null;
  const scopeName = (device: PairedDevice) => deviceAccessName(device, targets);
  const limitedEmpty = access === "limited" && pickedCount(knownTargets(picked, targets)) === 0;
  const pairButton = (
    <button type="button" data-phone-pairing-action={reveal ? "" : undefined} data-settings-drop="" onClick={() => void create()} disabled={busy || !pairingCodes || limitedEmpty}
      className={cn("ui-button ui-button-primary", !pairingCodes && "opacity-40")}>
      {busy ? t("remote.serverPairing.creating") : t("phone.pair.button")}
    </button>
  );
  const choices = !simple && pairingCodes && !cloudHome ? (
    <Select variant="ghost" name="server-pairing-scope" value={access} aria-label={t("remote.serverPairing.view.label")} onChange={(event) => setAccess(event.target.value as DeviceAccess)}>
      <option value="admin">{t("remote.serverPairing.scope.admin")}</option>
      <option value="client">{t("remote.serverPairing.scope.client")}</option>
      <option value="limited">{t("remote.serverPairing.view.limited")}</option>
    </Select>
  ) : null;
  const newDevicePicker = choices && access === "limited" ? (
    <div className="px-4">
      <ViewTargetPicker targets={targets} picked={picked} onToggle={(kind, id) => setPicked((view) => togglePicked(view, kind, id))} />
      {limitedEmpty ? <p className="mt-2 text-[12px] leading-4 text-ink-secondary">{t("remote.serverPairing.view.pickOne")}</p> : null}
    </div>
  ) : null;
  const viewButton = (device: PairedDevice) => cloudHome || device.id === current ? null : (
    <button type="button" className="settings-quiet shrink-0 cursor-pointer" data-device-view={device.id} aria-label={t("remote.serverPairing.view.change", { device: device.label })}
      disabled={targets === NO_TARGETS}
      onClick={() => setEditing(editing?.id === device.id ? null : { id: device.id, picked: knownTargets(device.view ?? EMPTY_VIEW, targets) })}>
      {t(device.view ? "remote.serverPairing.view.edit" : "remote.serverPairing.view.limit")}
    </button>
  );
  const viewEditor = (device: PairedDevice) => editing?.id !== device.id ? null : (
    <div data-device-view-editor={device.id} className="basis-full rounded-lg border border-hairline/40 bg-inset p-3">
      {limitWarning(device) ? <p className="mb-2 text-[12px] leading-4 text-ink-secondary">{limitWarning(device)}</p> : null}
      <ViewTargetPicker targets={targets} picked={editing.picked} saving={editing.saving} onToggle={(kind, id) => void flip(device, editing.picked, kind, id)} />
      <div className="mt-3 flex flex-wrap gap-2">
        {device.view ? <button type="button" className={quiet} disabled={editing.saving} onClick={() => void unlimit(device)}>{t("remote.serverPairing.view.unlimit")}</button> : null}
        <button type="button" className={quiet} onClick={() => setEditing(null)}>{t("common.done")}</button>
      </div>
    </div>
  );
  const nameRow = !simple && pairingCodes && !cloudHome && computerName !== null
    ? <SettingsRows><ComputerNameRow saved={computerName} onSaved={setComputerName} className="px-4 py-3" /></SettingsRows> : null;
  const pairRow = (
    <PairRow reason={pairingCodes ? null : t("remote.serverPairing.portalShort")}>
      {choices}{pairButton}
    </PairRow>
  );

  return (
    <div ref={root} tabIndex={-1} data-phone-pairing="server" className="flex scroll-mt-4 flex-col gap-6 focus:outline-none">
      {offerPanel}
      {listed.length === 0 ? (
        <SettingsGroup block="pair">
          <SettingsRows>{pairRow}</SettingsRows>
          {newDevicePicker}
          {nameRow}
          {!pairingCodes && <p data-server-pairing-portal className="px-4 text-[12px] leading-4 text-ink-secondary">{t("remote.serverPairing.portal")}</p>}
        </SettingsGroup>
      ) : (
        <SettingsGroup label={t(pairingCodes ? "devices.paired" : "remote.serverPairing.portalDevices")} block="paired" actions={pairingCodes ? <span className="flex items-center gap-2">{choices}{pairButton}</span> : undefined}>
            {newDevicePicker}
            <SettingsRows icons>
              {listed.map((device) => (
                <div key={device.id} className="flex min-h-16 flex-wrap items-center gap-3 px-4 py-3" data-paired-device={device.id}>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary"><Smartphone size={18} strokeWidth={1.75} aria-hidden="true" /></span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[14px] leading-5 text-ink">{device.label}</span>
                    <span className="truncate text-[13px] leading-[18px] text-ink-secondary">
                      {[device.email, cloudHome ? null : scopeName(device), t("remote.serverPairing.seen", { when: lastSeen(device.lastSeenAt, now) }), device.id === current ? t("remote.serverPairing.thisBrowser") : null].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {viewButton(device)}
                  {device.id === current ? null : (
                    <button type="button" onClick={() => void signOut(device.id)} data-danger="" className="settings-quiet shrink-0 cursor-pointer">{t("phone.devices.remove")}</button>
                  )}
                  {viewEditor(device)}
                </div>
              ))}
            </SettingsRows>
            {nameRow}
            {!pairingCodes && <p data-server-pairing-portal className="px-4 text-[12px] leading-4 text-ink-secondary">{t("remote.serverPairing.portal")}</p>}
          </SettingsGroup>
      )}
      {error ? <p className="px-4 text-[12px] leading-4 text-danger">{error}</p> : null}
    </div>
  );
}
