import { useEffect, useState } from "react";
import { Check, Lock, Minus } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { productName } from "@/lib/brand";
import type { PhoneSetupController } from "./PhoneSetupFlow";

/** A fresh code while this screen is open; the previous one stays valid to its two-minute end, so a phone mid-scan
 * never misses. */
export const PAIRING_RENEW_MS = 100_000;

function RouteRow({ on, label, value }: { on: boolean; label: string; value: string }) {
  return (
    <div className="flex h-7 items-center gap-2 text-left">
      {on ? <Check size={14} className="shrink-0 text-success" /> : <Minus size={14} className="shrink-0 text-ink-tertiary" />}
      <span className="w-[120px] shrink-0 text-[13px] text-ink">{label}</span>
      <span className="min-w-0 truncate text-[12px] text-ink-secondary">{value}</span>
    </div>
  );
}

/** The pairing screen once this computer serves the encrypted connection: one QR carries every route, renews itself,
 * and has no countdown, no code and no cancel. */
export function PhonePairingQr({ c, signedIn }: { c: PhoneSetupController; signedIn: boolean }) {
  const [copied, setCopied] = useState(false);
  const state = c.state;
  const renewing = Boolean(state?.pairing);
  useEffect(() => {
    if (!renewing) return;
    const timer = setInterval(() => {
      void c.act((companion) => (companion.renewPairing ? companion.renewPairing() : companion.pairing(true)));
    }, PAIRING_RENEW_MS);
    return () => clearInterval(timer);
  }, [renewing, c]);
  if (!state || !c.pairingLink) return null;
  const lan = state.lan ?? state.addresses?.[0] ?? null;
  const relay = state.e2e?.descriptor?.r?.length ? state.e2e.relay : null;
  const copy = () => {
    void copyText(c.pairingLink ?? "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_500);
    });
  };
  return (
    <div className="flex w-full max-w-[440px] flex-col items-center text-center">
      <div className="rounded-2xl bg-white p-3.5 transition-opacity duration-150" aria-label={t("phone.code.qrAria")}>
        <QRCodeSVG key={state.pairing?.token} value={c.pairingLink} size={320} level="L" marginSize={1} bgColor="#ffffff" fgColor="#111111" />
      </div>
      <p className="mt-4 text-[13px] text-ink-secondary">{t("phone.code.scanInApp", { app: productName() })}</p>
      <p className="mt-1 text-[12px] text-ink-tertiary">{t("phone.code.notCamera", { app: productName() })}</p>
      <div className="mt-5 w-full px-2">
        <RouteRow on={Boolean(lan)} label={t("phone.code.e2e.wifi")} value={lan ?? ""} />
        <RouteRow on={Boolean(state.tailnetName)} label={t("phone.code.e2e.tailscale")} value={state.tailnetName ?? t("phone.code.e2e.tailscaleOff")} />
        <RouteRow
          on={Boolean(relay)}
          label={t("phone.code.e2e.relay")}
          value={relay ? t("phone.code.e2e.fromAnywhere") : signedIn ? t("phone.code.e2e.relayOff") : t("phone.code.e2e.signIn")}
        />
      </div>
      {c.localFallback && state.publicNetwork && (
        <p role="note" className="mt-3 w-full rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-left text-[12px] leading-relaxed text-warning">
          {t("phone.code.publicNetwork", { network: state.publicNetwork })}
        </p>
      )}
      <p className="mt-4 flex items-start gap-1.5 px-2 text-left text-[12px] text-ink-tertiary">
        <Lock size={12} className="mt-0.5 shrink-0" />
        {t("phone.code.e2e.encrypted")}
      </p>
      <div className="mt-5 flex w-full px-2">
        <button onClick={copy} className="text-[12px] text-ink-secondary hover:text-ink">{t("phone.code.e2e.copyLink")}</button>
      </div>
      <p className="mt-4 w-full px-2 text-left text-[12px] text-ink-secondary">{t("phone.pair.installPlain", { app: productName() })}</p>
      {copied && (
        <div role="status" className="mt-3 rounded-lg bg-inset px-3 py-1.5 text-[12px] text-ink">{t("phone.code.e2e.copied")}</div>
      )}
    </div>
  );
}
