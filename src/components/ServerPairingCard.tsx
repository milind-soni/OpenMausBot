import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { t } from "@/lib/i18n";
import { copyText, type CopyFeedback } from "@/lib/copy-text";
import { api } from "@/state/store";
import { isOwnerOrAdmin, readSessionState, type SessionState } from "../lib/session";
import { readMembership } from "../lib/membership";
import { lastSeen, minutesLeft } from "../lib/pairing-time";
import { revealPhonePairing } from "../lib/phone-pairing";
import { Card, SettingRow, SIMPLE_CARD, Switch } from "./SettingsPrimitives";
import { Select } from "./Select";
import { cn } from "@/lib/cn";
import { TeamPhoneCard } from "./TeamPhoneCard";
import type { DeviceView } from "../../shared/device-view";
import { EMPTY_VIEW, flipTarget, knownTargets, NO_TARGETS, pairingBody, pickedCount, togglePicked, viewNames, viewTargetsFrom, type DeviceAccess, type DeviceViewTargets } from "../lib/device-view-choice";

export interface PairingOffer {
  id: string;
  code: string;
  expiresAt: number;
  url: string | null;
  hint: string | null;
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

export function shownDevices(devices: PairedDevice[], cloudHome: boolean): PairedDevice[] {
  return cloudHome ? devices.filter((device) => device.scopes.includes("admin")) : devices;
}

const button = "ui-button ui-button-primary";
const quiet = "ui-button";

export function ViewTargetPicker({ targets, picked, onToggle, saving = false }: { targets: DeviceViewTargets; picked: DeviceView; onToggle: (kind: keyof DeviceView, id: string) => void; saving?: boolean }) {
  const kinds: Array<{ kind: keyof DeviceView; label: string; items: Array<{ id: string; name: string }> }> = [
    { kind: "sections", label: t("remote.serverPairing.view.department"), items: targets.sections.map((section) => ({ id: section, name: section.trim() || t("remote.serverPairing.view.general") })) },
    { kind: "bots", label: t("remote.serverPairing.view.bot"), items: targets.bots },
    { kind: "groups", label: t("remote.serverPairing.view.group"), items: targets.groups },
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

export function ServerPairingCard({ initialSession = null, initialPairingCodes = true, cloudHome = false, focusRequest = 0, team, simple = false }: { initialSession?: SessionState | null; initialPairingCodes?: boolean; cloudHome?: boolean; focusRequest?: number; team?: string; simple?: boolean }) {
  const [session, setSession] = useState<SessionState | null>(initialSession);
  const [pairingCodes, setPairingCodes] = useState(initialPairingCodes);
  const [access, setAccess] = useState<DeviceAccess>("admin");
  const [picked, setPicked] = useState<DeviceView>(EMPTY_VIEW);
  const [editing, setEditing] = useState<{ id: string; picked: DeviceView; saving?: boolean } | null>(null);
  const savingView = useRef(false);
  const [targets, setTargets] = useState<DeviceViewTargets>(NO_TARGETS);
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
        void api("/api/config").then((config) => setPairingCodes(readMembership(config).pairingCodes)).catch(() => {});
      }
    });
  }, []);

  useEffect(() => {
    if (!focusRequest) revealed.current = 0;
    else if (revealed.current !== focusRequest && revealPhonePairing(root.current)) revealed.current = focusRequest;
  }, [focusRequest, session]);

  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [offer]);

  if (team && session?.kind === "session" && session.team) {
    return (
      <div ref={root} tabIndex={-1} data-phone-pairing="server" className="scroll-mt-4 rounded-xl focus:outline-none">
        <TeamPhoneCard team={team} />
      </div>
    );
  }
  if (!canPairDevices(session)) {
    if (pairingBlockedReason(session) !== "chat-only") return null;
    return (
      <div ref={root} tabIndex={-1} data-phone-pairing="server" className="scroll-mt-4 rounded-xl focus:outline-none">
        <Card title={t("remote.serverPairing.title")} subtitle={t(pairingCodes ? "remote.serverPairing.subtitle" : "remote.serverPairing.portalSubtitle")}>
          <p data-server-pairing-chat-only className="mt-3 text-[13px] text-ink-secondary">{t(pairingCodes ? "remote.serverPairing.chatOnly" : "remote.serverPairing.portalChatOnly")}</p>
        </Card>
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

  const offerPanel = pairingCodes && offer ? (
        <div className="mt-4 rounded-lg border border-hairline/40 bg-inset p-4">
          {expired ? (
            <p className="text-[13px] text-ink-secondary">{t("remote.serverPairing.expired")}</p>
          ) : (
            <div className="flex flex-wrap items-start gap-5">
              {offer.url ? (
                <div className="rounded-md bg-white p-2">
                  <QRCodeSVG value={offer.url} size={160} level="M" bgColor="#ffffff" fgColor="#111111" />
                </div>
              ) : null}
              <div className="min-w-[200px] flex-1">
                <div className="font-mono text-[18px] tracking-[0.14em] text-ink">{offer.code}</div>
                <div className="mt-1 text-[13px] text-ink-secondary">{t("remote.serverPairing.expires", { minutes: minutesLeft(offer.expiresAt, now) })}</div>
                {offer.url ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <code className="break-all text-[12px] text-ink-secondary">{offer.url}</code>
                    <button type="button" onClick={() => void copyLink()} className={quiet}>
                      {t(copied === "copied" ? "remote.serverPairing.copied" : copied === "failed" ? "common.copyFailed" : "remote.serverPairing.copyLink")}
                    </button>
                  </div>
                ) : (
                  <p className="mt-3 text-[13px] text-ink-secondary">{offer.hint ?? t("remote.serverPairing.noLink")}</p>
                )}
              </div>
            </div>
          )}
        </div>
  ) : null;
  const scopeName = (device: PairedDevice) => deviceAccessName(device, targets);
  const limitedEmpty = access === "limited" && pickedCount(knownTargets(picked, targets)) === 0;
  const accessSelect = (props: { variant?: "ghost"; size?: "sm"; name?: string; "aria-label"?: string }) => (
    <Select {...props} value={access} onChange={(event) => setAccess(event.target.value as DeviceAccess)}>
      <option value="admin">{t("remote.serverPairing.scope.admin")}</option>
      <option value="client">{t("remote.serverPairing.scope.client")}</option>
      <option value="limited">{t("remote.serverPairing.view.limited")}</option>
    </Select>
  );
  const newDevicePicker = !cloudHome && access === "limited" ? (
    <div className="rounded-lg border border-hairline/40 bg-inset p-3">
      <ViewTargetPicker targets={targets} picked={picked} onToggle={(kind, id) => setPicked((view) => togglePicked(view, kind, id))} />
      {limitedEmpty ? <p className="mt-2 text-[12px] text-ink-secondary">{t("remote.serverPairing.view.pickOne")}</p> : null}
    </div>
  ) : null;
  const viewButton = (device: PairedDevice) => cloudHome || device.id === current ? null : (
    <button type="button" className={quiet} data-device-view={device.id} aria-label={t("remote.serverPairing.view.change", { device: device.label })}
      disabled={targets === NO_TARGETS}
      onClick={() => setEditing(editing?.id === device.id ? null : { id: device.id, picked: knownTargets(device.view ?? EMPTY_VIEW, targets) })}>
      {t(device.view ? "remote.serverPairing.view.edit" : "remote.serverPairing.view.limit")}
    </button>
  );
  const viewEditor = (device: PairedDevice) => editing?.id !== device.id ? null : (
    <div data-device-view-editor={device.id} className="basis-full rounded-lg border border-hairline/40 bg-inset p-3">
      {limitWarning(device) ? <p className="mb-2 text-[12px] text-ink-secondary">{limitWarning(device)}</p> : null}
      <ViewTargetPicker targets={targets} picked={editing.picked} saving={editing.saving} onToggle={(kind, id) => void flip(device, editing.picked, kind, id)} />
      <div className="mt-3 flex flex-wrap gap-2">
        {device.view ? <button type="button" className={quiet} disabled={editing.saving} onClick={() => void unlimit(device)}>{t("remote.serverPairing.view.unlimit")}</button> : null}
        <button type="button" className={quiet} onClick={() => setEditing(null)}>{t("common.done")}</button>
      </div>
    </div>
  );

  if (simple) {
    return (
      <div ref={root} tabIndex={-1} data-phone-pairing="server" className="flex scroll-mt-4 flex-col gap-1.5 focus:outline-none">
        <div data-settings-rows="" className={cn(SIMPLE_CARD, "flex flex-col")}>
          <SettingRow title={t("settings.simple.computer.pair")} subtitle={pairingCodes ? cloudHome ? t("remote.serverPairing.cloudPersonal") : undefined : t("remote.serverPairing.portal")}>
            {pairingCodes ? (
              <div className="flex items-center gap-2">
                {cloudHome ? null : accessSelect({ variant: "ghost", "aria-label": t("remote.serverPairing.view.label") })}
                <button type="button" data-phone-pairing-action onClick={() => void create()} disabled={busy || limitedEmpty} className="ui-button">
                  {busy ? t("remote.serverPairing.creating") : t("settings.simple.computer.createCode")}
                </button>
              </div>
            ) : null}
          </SettingRow>
          {newDevicePicker ? <div className="px-4 pb-2.5">{newDevicePicker}</div> : null}
          {offerPanel ? <div className="px-4 pb-2.5 [&>div]:mt-0">{offerPanel}</div> : null}
          {listed.length === 0 ? (
            <p className="px-4 py-2.5 text-[13px] leading-[18px] text-ink-secondary">{t("remote.serverPairing.noDevices")}</p>
          ) : listed.map((device) => (
            <div key={device.id} className="flex min-h-11 flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
              <span className="min-w-[min(100%,15rem)] flex-1 text-[14px] leading-5 text-ink">
                {device.label}
                <span className="text-ink-secondary">
                  {" · "}{scopeName(device)}{" · "}{t("remote.serverPairing.seen", { when: lastSeen(device.lastSeenAt, now) })}
                  {device.id === current ? ` · ${t("remote.serverPairing.thisBrowser")}` : ""}
                </span>
              </span>
              {viewButton(device)}
              {device.id === current ? null : (
                <button type="button" onClick={() => void signOut(device.id)} className="ui-button ml-auto shrink-0">{t("remote.serverPairing.signOut")}</button>
              )}
              {viewEditor(device)}
            </div>
          ))}
        </div>
        {error ? <p className="pl-4 text-[12px] leading-4 text-danger">{error}</p> : null}
      </div>
    );
  }

  return (
    <div ref={root} tabIndex={-1} data-phone-pairing="server" className="scroll-mt-4 rounded-xl focus:outline-none">
    <Card title={t("remote.serverPairing.title")} subtitle={t(pairingCodes ? "remote.serverPairing.subtitle" : "remote.serverPairing.portalSubtitle")}>
      {pairingCodes && cloudHome ? <p data-server-pairing-personal className="mt-3 text-[13px] text-ink-secondary">{t("remote.serverPairing.cloudPersonal")}</p> : null}
      {pairingCodes ? <div className="mt-3 flex flex-wrap items-center gap-3">
        {cloudHome ? null : (
          <label className="flex items-center gap-2 text-[13px] text-ink">
            {t("remote.serverPairing.view.label")}
            {accessSelect({ size: "sm", name: "server-pairing-scope" })}
          </label>
        )}
        <button type="button" data-phone-pairing-action onClick={() => void create()} disabled={busy || limitedEmpty} className={button}>
          {busy ? t("remote.serverPairing.creating") : t("remote.serverPairing.create")}
        </button>
      </div> : <p data-server-pairing-portal className="mt-3 text-[13px] text-ink-secondary">{t("remote.serverPairing.portal")}</p>}
      {newDevicePicker ? <div className="mt-3">{newDevicePicker}</div> : null}
      {offerPanel}
      <div className="mt-5 text-[13px] font-medium text-ink">{t(pairingCodes ? "remote.serverPairing.devices" : "remote.serverPairing.portalDevices")}</div>
      {listed.length === 0 ? (
        <p className="mt-1 text-[13px] text-ink-secondary">{t("remote.serverPairing.noDevices")}</p>
      ) : (
        <ul className="mt-1 divide-y divide-hairline/40">
          {listed.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
              <span className="text-ink">
                {device.label}
                {device.email ? <span className="text-ink-secondary"> · {device.email}</span> : null}
                <span className="text-ink-secondary">
                  {" · "}
                  {scopeName(device)}
                  {" · "}
                  {t("remote.serverPairing.seen", { when: lastSeen(device.lastSeenAt, now) })}
                  {device.id === current ? ` · ${t("remote.serverPairing.thisBrowser")}` : ""}
                </span>
              </span>
              <span className="flex items-center gap-2">
              {viewButton(device)}
              {device.id === current ? null : (
                <button type="button" onClick={() => void signOut(device.id)} className={quiet}>
                  {t("remote.serverPairing.signOut")}
                </button>
              )}
              </span>
              {viewEditor(device)}
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
    </Card>
    </div>
  );
}
