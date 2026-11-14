import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { t } from "@/lib/i18n";
import { copyText, type CopyFeedback } from "@/lib/copy-text";
import { api } from "@/state/store";
import { isOwnerOrAdmin, readSessionState, type SessionState } from "../lib/session";
import { readMembership } from "../lib/membership";
import { codeUntil, lastSeen } from "../lib/pairing-time";
import { revealPhonePairing, takePairOnOpen } from "../lib/phone-pairing";
import { SettingsGroup, SettingsRows } from "./SettingsPrimitives";
import { Layer } from "./Layer";
import { DialogTitle, PairRow } from "./PhoneDevicesSection";
import { Smartphone } from "lucide-react";
import { productName } from "@/lib/brand";
import { Select } from "./Select";
import { cn } from "@/lib/cn";
import { TeamPhoneCard } from "./TeamPhoneCard";
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


export function ServerPairingCard({ initialSession = null, initialPairingCodes = true, cloudHome = false, focusRequest = 0, team, teamPhoneBlocked = null, simple = false, reveal = true, placeName = "" }: { placeName?: string; initialSession?: SessionState | null; initialPairingCodes?: boolean; cloudHome?: boolean; focusRequest?: number; team?: string; teamPhoneBlocked?: string | null; simple?: boolean; /** False where another pairing flow owns the page's focus. */ reveal?: boolean }) {
  const [session, setSession] = useState<SessionState | null>(initialSession);
  const [pairingCodes, setPairingCodes] = useState(initialPairingCodes);
  const [computerName, setComputerName] = useState<string | null>(null);
  const [scope, setScope] = useState<"admin" | "client">("admin");
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
      const body: PairingOffer = await api("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: scope === "admin" || cloudHome ? ["admin", "client"] : ["client"] }) });
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
  const scopeName = (device: PairedDevice) => t(device.scopes.includes("admin") ? "remote.serverPairing.scope.admin" : "remote.serverPairing.scope.client");
  const pairButton = (
    <button type="button" data-phone-pairing-action={reveal ? "" : undefined} data-settings-drop="" onClick={() => void create()} disabled={busy || !pairingCodes}
      className={cn("ui-button ui-button-primary", !pairingCodes && "opacity-40")}>
      {busy ? t("remote.serverPairing.creating") : t("phone.pair.button")}
    </button>
  );
  const choices = !simple && pairingCodes && !cloudHome ? (
    <Select variant="ghost" value={scope} aria-label={t("remote.serverPairing.title")} onChange={(event) => setScope(event.target.value === "client" ? "client" : "admin")}>
      <option value="admin">{t("remote.serverPairing.scope.admin")}</option>
      <option value="client">{t("remote.serverPairing.scope.client")}</option>
    </Select>
  ) : null;
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
          {nameRow}
          {!pairingCodes && <p data-server-pairing-portal className="px-4 text-[12px] leading-4 text-ink-secondary">{t("remote.serverPairing.portal")}</p>}
        </SettingsGroup>
      ) : (
        <SettingsGroup label={t(pairingCodes ? "devices.paired" : "remote.serverPairing.portalDevices")} block="paired" actions={pairingCodes ? <span className="flex items-center gap-2">{choices}{pairButton}</span> : undefined}>
            <SettingsRows icons>
              {listed.map((device) => (
                <div key={device.id} className="flex min-h-16 items-center gap-3 px-4 py-3" data-paired-device={device.id}>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary"><Smartphone size={18} strokeWidth={1.75} aria-hidden="true" /></span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[14px] leading-5 text-ink">{device.label}</span>
                    <span className="truncate text-[13px] leading-[18px] text-ink-secondary">
                      {[device.email, cloudHome ? null : scopeName(device), t("remote.serverPairing.seen", { when: lastSeen(device.lastSeenAt, now) }), device.id === current ? t("remote.serverPairing.thisBrowser") : null].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {device.id === current ? null : (
                    <button type="button" onClick={() => void signOut(device.id)} data-danger="" className="settings-quiet shrink-0 cursor-pointer">{t("phone.devices.remove")}</button>
                  )}
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
