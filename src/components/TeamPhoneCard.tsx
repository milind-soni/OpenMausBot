import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { t } from "@/lib/i18n";
import { lastSeen, minutesLeft } from "@/lib/pairing-time";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

export const TEAM_PHONE_PAIRING = "/api/team/phone-pairing";
export const TEAM_PHONES = "/api/team/phones";
export const PHONE_ARRIVAL_POLL_MS = 4_000;

interface TeamPhoneCode { code: string; expiresAt: number; url: string | null; hint: string | null }

/** A phone the server lists for this person: their own, or every member's for an admin. */
export interface TeamPhone { id: string; label: string; email: string; lastSeenAt: number; expiresAt: number }

function phoneRow(phone: Pick<TeamPhone, "label" | "email">): string {
  return `${phone.label} · ${phone.email}`;
}

/** A Team Cloud's "Open on your phone", for every member: one code, made for whoever is signed in, and the phones it opened. */
export function TeamPhoneCard({ team }: { team: string }) {
  const [offer, setOffer] = useState<TeamPhoneCode | null>(null);
  const [phones, setPhones] = useState<TeamPhone[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const fail = (cause: unknown) => setError(t("remote.serverPairing.error", { error: cause instanceof Error ? cause.message : String(cause) }));

  async function loadPhones() {
    try {
      const body = await api(TEAM_PHONES);
      setPhones(Array.isArray(body?.phones) ? body.phones : []);
      setCurrent(typeof body?.current === "string" ? body.current : null);
    } catch (cause) {
      fail(cause);
    }
  }

  useEffect(() => {
    void loadPhones();
  }, []);

  const expired = offer ? offer.expiresAt <= now : false;
  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [offer]);
  useEffect(() => {
    if (!offer || expired) return;
    const timer = setInterval(() => void loadPhones(), PHONE_ARRIVAL_POLL_MS);
    return () => clearInterval(timer);
  }, [offer, expired]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setOffer(await api(TEAM_PHONE_PAIRING, { method: "POST", body: "{}" }));
      setNow(Date.now());
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api(`${TEAM_PHONES}/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (cause) {
      fail(cause);
    }
    await loadPhones();
  }

  return (
    <Card title={t("teamPhone.title")} subtitle={t("teamPhone.subtitle", { team })}>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" data-phone-pairing-action onClick={() => void create()} disabled={busy} className="ui-button ui-button-primary">
          {busy ? t("remote.serverPairing.creating") : t("remote.serverPairing.create")}
        </button>
      </div>
      {offer ? (
        <div data-team-phone-code className="mt-4 rounded-lg border border-hairline/40 bg-inset p-4">
          {expired ? <p className="text-[13px] text-ink-secondary">{t("remote.serverPairing.expired")}</p> : (
            <div className="flex flex-wrap items-start gap-5">
              {offer.url ? (
                <div className="rounded-md bg-white p-2">
                  <QRCodeSVG value={offer.url} size={160} level="M" bgColor="#ffffff" fgColor="#111111" />
                </div>
              ) : null}
              <div className="min-w-[200px] flex-1">
                <div className="font-mono text-[18px] tracking-[0.14em] text-ink">{offer.code}</div>
                <div className="mt-1 text-[12.5px] text-ink-secondary">{t("remote.serverPairing.expires", { minutes: minutesLeft(offer.expiresAt, now) })}</div>
                {offer.url ? null : <p className="mt-3 text-[12.5px] text-ink-secondary">{offer.hint ?? t("remote.serverPairing.noLink")}</p>}
              </div>
            </div>
          )}
        </div>
      ) : null}
      <p className="mt-3 text-[12.5px] text-ink-secondary">{t("teamPhone.stays", { team })}</p>
      {phones ? (
        <div data-team-phones>
          <div className="mt-5 text-[13px] font-medium text-ink">{t("remote.serverPairing.devices")}</div>
          {phones.length === 0 ? (
            <p className="mt-1 text-[12.5px] text-ink-secondary">{t("remote.serverPairing.noDevices")}</p>
          ) : (
            <ul className="mt-1 divide-y divide-hairline/40">
              {phones.map((phone) => (
                <li key={phone.id} data-team-phone={phone.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
                  <span className="text-ink">
                    {phoneRow(phone)}
                    <span className="text-ink-secondary">
                      {" · "}
                      {t("remote.serverPairing.seen", { when: lastSeen(phone.lastSeenAt, now) })}
                      {phone.id === current ? ` · ${t("remote.serverPairing.thisBrowser")}` : ""}
                    </span>
                  </span>
                  {phone.id === current ? null : (
                    <button type="button" data-team-phone-remove onClick={() => void remove(phone.id)} className="ui-button">
                      {t("teamPhone.remove")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
    </Card>
  );
}
