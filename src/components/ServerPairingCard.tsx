import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import { readSessionState, type SessionState } from "../lib/session";
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
  if (!state) return false;
  return state.kind === "loopback" || (state.kind === "session" && state.scopes.includes("admin"));
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

const button = "rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink disabled:opacity-50";
const quiet = "rounded-md border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-surface";

/** Settings → Remote access on a hosted server: mint a one-time pairing
 * code with a QR for the phone app, and see or sign out the devices that
 * hold a session. The desktop app has its own companion flow and never
 * shows this. */
export function ServerPairingCard() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [scope, setScope] = useState<"admin" | "client">("admin");
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

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
    });
  }, []);

  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [offer]);

  if (!canPairDevices(session)) return null;
  const expired = offer ? offer.expiresAt <= now : false;

  async function create() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const body: PairingOffer = await api("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: scope === "admin" ? ["admin", "client"] : ["client"] }) });
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
    try {
      await navigator.clipboard.writeText(offer.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card title={t("remote.serverPairing.title")} subtitle={t("remote.serverPairing.subtitle")}>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[13px] text-ink">
          <input type="radio" name="server-pairing-scope" checked={scope === "admin"} onChange={() => setScope("admin")} />
          {t("remote.serverPairing.scope.admin")}
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-ink">
          <input type="radio" name="server-pairing-scope" checked={scope === "client"} onChange={() => setScope("client")} />
          {t("remote.serverPairing.scope.client")}
        </label>
        <button type="button" onClick={() => void create()} disabled={busy} className={button}>
          {busy ? t("remote.serverPairing.creating") : t("remote.serverPairing.create")}
        </button>
      </div>
      {offer ? (
        <div className="mt-4 rounded-lg border border-line bg-surface p-4">
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
                      {copied ? t("remote.serverPairing.copied") : t("remote.serverPairing.copyLink")}
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
      <div className="mt-5 text-[13px] font-medium text-ink">{t("remote.serverPairing.devices")}</div>
      {devices.length === 0 ? (
        <p className="mt-1 text-[12.5px] text-ink-secondary">{t("remote.serverPairing.noDevices")}</p>
      ) : (
        <ul className="mt-1 divide-y divide-line">
          {devices.map((device) => (
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
  );
}
