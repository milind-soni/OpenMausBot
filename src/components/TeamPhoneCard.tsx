import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

export const TEAM_PHONE_PAIRING = "/api/team/phone-pairing";

interface TeamPhoneCode { code: string; expiresAt: number; url: string | null; hint: string | null }

/** A Team Cloud's "Open on your phone", for every member: one code, made for whoever is signed in. */
export function TeamPhoneCard({ team }: { team: string }) {
  const [offer, setOffer] = useState<TeamPhoneCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [offer]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setOffer(await api(TEAM_PHONE_PAIRING, { method: "POST", body: "{}" }));
      setNow(Date.now());
    } catch (cause) {
      setError(t("remote.serverPairing.error", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setBusy(false);
    }
  }

  const expired = offer ? offer.expiresAt <= now : false;
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
                <div className="mt-1 text-[12.5px] text-ink-secondary">{t("remote.serverPairing.expires", { minutes: Math.max(0, Math.ceil((offer.expiresAt - now) / 60_000)) })}</div>
                {offer.url ? null : <p className="mt-3 text-[12.5px] text-ink-secondary">{offer.hint ?? t("remote.serverPairing.noLink")}</p>}
              </div>
            </div>
          )}
        </div>
      ) : null}
      <p className="mt-3 text-[12.5px] text-ink-secondary">{t("teamPhone.stays", { team })}</p>
      {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
    </Card>
  );
}
