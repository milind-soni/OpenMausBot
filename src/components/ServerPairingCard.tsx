import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { t } from "@/lib/i18n";
import { copyText, type CopyFeedback } from "@/lib/copy-text";
import { api } from "@/state/store";
import { isOwnerOrAdmin, readSessionState, type SessionState } from "../lib/session";
import { readMembership } from "../lib/membership";
import { revealPhonePairing } from "../lib/phone-pairing";
import { Card } from "./SettingsPrimitives";

/** What the server hands out for a new device (POST /api/auth/pairing). */
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
}

/** The server's owner on its own machine, or an admin session, may pair
 * devices; a chat-only session must not even see the offer. */
export function canPairDevices(state: SessionState | null): boolean {
  return isOwnerOrAdmin(state);
}

/** A session that may see the card but not act: say why, instead of showing
 * nothing at all. Only a paired session can be chat-only; loopback is the
 * owner, and the unauthenticated case never reaches Settings. */
export function pairingBlockedReason(state: SessionState | null): "chat-only" | null {
  return state?.kind === "session" && !state.scopes.includes("admin") ? "chat-only" : null;
}

/** The devices the card lists: on an OMB Cloud home only the owner's own,
 * each with full access (the server lists no other). */
export function shownDevices(devices: PairedDevice[], cloudHome: boolean): PairedDevice[] {
  return cloudHome ? devices.filter((device) => device.scopes.includes("admin")) : devices;
}

export function minutesLeft(expiresAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

export function lastSeen(lastSeenAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - lastSeenAt) / 60_000));
  if (minutes < 1) return t("remote.serverPairing.justNow");
  if (minutes < 60) return t("remote.serverPairing.minutesAgo", { minutes });
  if (minutes < 1440) return t("remote.serverPairing.hoursAgo", { hours: Math.round(minutes / 60) });
  return t("remote.serverPairing.daysAgo", { days: Math.round(minutes / 1440) });
}

const button = "ui-button ui-button-primary";
const quiet = "ui-button";

/** Settings → Remote access: mint a one-time pairing code with a QR for
 * the phone app (or for a non-phone client — MCP, `openmausbot pair`, a
 * second desktop app), and see or sign out the devices that hold a
 * session. Shown for every client of a server: a hosted server reached
 * from a browser, the desktop app's own local server (#950), and the
 * desktop app connected to a hosted workspace, whose requests reach that
 * server with the paired session — the only place its phones can be
 * paired from (MOCA-84). `canPairDevices` decides who may act. On an OMB
 * Cloud home (`cloudHome`), which is personal, every device paired is one of
 * the owner's own, with full access: no chat-only choice, only the owner's
 * devices listed, and one line saying why. `focusRequest` counts up when
 * "Connect your phone" opened Settings here: the card scrolls into view with
 * focus on Create pairing code, once it knows what it may show. */
export function ServerPairingCard({ initialSession = null, initialPairingCodes = true, cloudHome = false, focusRequest = 0 }: { initialSession?: SessionState | null; initialPairingCodes?: boolean; cloudHome?: boolean; focusRequest?: number }) {
  const [session, setSession] = useState<SessionState | null>(initialSession);
  // A hosted workspace refuses pairing codes: people sign in through the
  // organisation's portal. Offer only the signed-in devices there.
  const [pairingCodes, setPairingCodes] = useState(initialPairingCodes);
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
        void api("/api/config").then((config) => setPairingCodes(readMembership(config).pairingCodes)).catch(() => {});
      }
    });
  }, []);

  // The card renders nothing until the session is known; reveal it then,
  // once per request. Any other Settings navigation ends the request (0).
  useEffect(() => {
    if (!focusRequest) revealed.current = 0;
    else if (revealed.current !== focusRequest && revealPhonePairing(root.current)) revealed.current = focusRequest;
  }, [focusRequest, session]);

  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [offer]);

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

  return (
    <div ref={root} tabIndex={-1} data-phone-pairing="server" className="scroll-mt-4 rounded-xl focus:outline-none">
    <Card title={t("remote.serverPairing.title")} subtitle={t(pairingCodes ? "remote.serverPairing.subtitle" : "remote.serverPairing.portalSubtitle")}>
      {pairingCodes && cloudHome ? <p data-server-pairing-personal className="mt-3 text-[13px] text-ink-secondary">{t("remote.serverPairing.cloudPersonal")}</p> : null}
      {pairingCodes ? <div className="mt-3 flex flex-wrap items-center gap-3">
        {cloudHome ? null : <>
          <label className="flex items-center gap-1.5 text-[13px] text-ink">
            <input type="radio" name="server-pairing-scope" checked={scope === "admin"} onChange={() => setScope("admin")} />
            {t("remote.serverPairing.scope.admin")}
          </label>
          <label className="flex items-center gap-1.5 text-[13px] text-ink">
            <input type="radio" name="server-pairing-scope" checked={scope === "client"} onChange={() => setScope("client")} />
            {t("remote.serverPairing.scope.client")}
          </label>
        </>}
        <button type="button" data-phone-pairing-action onClick={() => void create()} disabled={busy} className={button}>
          {busy ? t("remote.serverPairing.creating") : t("remote.serverPairing.create")}
        </button>
      </div> : <p data-server-pairing-portal className="mt-3 text-[13px] text-ink-secondary">{t("remote.serverPairing.portal")}</p>}
      {pairingCodes && offer ? (
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
                <div className="mt-1 text-[12.5px] text-ink-secondary">{t("remote.serverPairing.expires", { minutes: minutesLeft(offer.expiresAt, now) })}</div>
                {offer.url ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <code className="break-all text-[12px] text-ink-secondary">{offer.url}</code>
                    <button type="button" onClick={() => void copyLink()} className={quiet}>
                      {t(copied === "copied" ? "remote.serverPairing.copied" : copied === "failed" ? "common.copyFailed" : "remote.serverPairing.copyLink")}
                    </button>
                  </div>
                ) : (
                  <p className="mt-3 text-[12.5px] text-ink-secondary">{offer.hint ?? t("remote.serverPairing.noLink")}</p>
                )}
              </div>
            </div>
          )}
        </div>
      ) : null}
      <div className="mt-5 text-[13px] font-medium text-ink">{t(pairingCodes ? "remote.serverPairing.devices" : "remote.serverPairing.portalDevices")}</div>
      {listed.length === 0 ? (
        <p className="mt-1 text-[12.5px] text-ink-secondary">{t("remote.serverPairing.noDevices")}</p>
      ) : (
        <ul className="mt-1 divide-y divide-hairline/40">
          {listed.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
              <span className="text-ink">
                {device.label}
                {device.email ? <span className="text-ink-secondary"> · {device.email}</span> : null}
                <span className="text-ink-secondary">
                  {" · "}
                  {device.scopes.includes("admin") ? t("remote.serverPairing.scope.admin") : t("remote.serverPairing.scope.client")}
                  {" · "}
                  {t("remote.serverPairing.seen", { when: lastSeen(device.lastSeenAt, now) })}
                  {device.id === current ? ` · ${t("remote.serverPairing.thisBrowser")}` : ""}
                </span>
              </span>
              {device.id === current ? null : (
                <button type="button" onClick={() => void signOut(device.id)} className={quiet}>
                  {t("remote.serverPairing.signOut")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
    </Card>
    </div>
  );
}
