import { useEffect, useRef, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { productName } from "@/lib/brand";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { codeUntil } from "@/lib/pairing-time";
import { HostFirewallNote, wifiOnlyCode } from "../HostFirewallNote";
import { reachLine } from "../PhoneDevicesSection";
import type { PhoneSetupController } from "../PhoneSetupFlow";
import { PhoneSetupFlowView } from "../PhoneSetupFlow";

/** "Waiting for it to connect…", then "X is connected". */
export function Waiting({ connected, waiting = t("devicesPage.addFlow.waiting") }: { connected: string | null; waiting?: string }) {
  return connected
    ? <p role="status" data-pair-state="connected" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink"><Check size={14} aria-hidden="true" className="text-success" />{t("devicesPage.addFlow.connected", { name: connected })}</p>
    : <p role="status" data-pair-state="waiting" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-secondary"><Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" />{waiting}</p>;
}

/** A code typed by hand: the code, in groups the eye can hold, then until when it works. */
export function TypedCode({ label, code, expiresAt }: { label: string; code: string; expiresAt: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[12px] leading-4 text-ink-tertiary">{label}</span>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span data-pairing-code="" className="font-mono text-[16px] font-medium leading-6 tracking-[0.12em] text-ink tabular-nums">{code}</span>
        <span className="text-[12px] leading-4 text-ink-tertiary">{codeUntil(expiresAt)}</span>
      </span>
    </div>
  );
}

/** Copy link, for a phone that can't scan: the link opened on the phone pairs it the same way. */
export function CopyPhoneLink({ link }: { link: string }) {
  const { state, copy } = useCopyFeedback(link);
  return <button type="button" onClick={copy} data-copy-link="" className="ui-button ui-button-sm w-fit">
    {t(state === "copied" ? "remote.serverPairing.copied" : state === "failed" ? "common.copyFailed" : "remote.serverPairing.copyLink")}
  </button>;
}

/** A phone's code: the QR on its white plate, with what to do, the code to type instead (or, with none, why there is
 * none and until when the QR works) and the wait beside it. */
export function PhoneCodeCard({ link, code, expiresAt, connected, noCode, children }: {
  link: string; code: string | null; expiresAt: number | null; connected: string | null; noCode?: ReactNode; children?: ReactNode;
}) {
  return (
    <div data-pair-panel="phone" className="flex flex-wrap items-start gap-4">
      <div data-pair-qr="" aria-label={t("phone.code.qrAria")} role="img" className="shrink-0 rounded-xl bg-white p-2.5 shadow-[inset_0_0_0_0.5px_var(--settings-edge)]">
        <QRCodeSVG value={link} size={148} level="M" bgColor="#ffffff" fgColor="#111111" />
      </div>
      <div className="flex min-w-[min(100%,13rem)] flex-1 flex-col gap-3">
        <p className="text-[13px] leading-[18px] text-ink">{t("phone.code.installAndScan", { app: productName() })}</p>
        {code && expiresAt ? <TypedCode label={t("devicesPage.addFlow.orType")} code={code} expiresAt={expiresAt} />
          : <span className="flex flex-col gap-0.5 empty:hidden">
            {noCode}
            {expiresAt && <span data-pair-until="" className="text-[12px] leading-4 text-ink-tertiary">{codeUntil(expiresAt)}</span>}
          </span>}
        <Waiting connected={connected} waiting={t("devicesPage.addFlow.waitingPhone")} />
        {children}
      </div>
    </div>
  );
}

/** Pair a phone's code on This computer, in the Devices page's own look; any other moment of the flow (signing in,
 * starting up) is the flow's own view. */
export function PhoneCodeInline({ c, started: asked = false }: { c: PhoneSetupController; /** the steps already started the flow (HTTPS Set up) */ started?: boolean }) {
  const pairing = c.state?.pairing;
  // Add a phone already asked for a code: a way in that is on goes straight to it, with no second "Pair" press.
  const started = useRef(asked);
  const { phase, start, useLocal, useTailscale } = c;
  const routes = c.state?.routes;
  useEffect(() => {
    if (started.current || phase !== "intro" || !routes) return;
    started.current = true;
    if (routes.wifi?.on || routes.relay?.on) useLocal();
    else if (routes.tailscale?.on) useTailscale();
    else start();
  }, [phase, routes, start, useLocal, useTailscale]);
  if (c.phase === "qr" && c.pairingExpired) {
    return <div className="flex flex-col items-start gap-3">
      <p className="text-[13px] leading-[18px] text-ink-secondary">{t("remote.serverPairing.expired")}</p>
      <button type="button" className="ui-button ui-button-sm" onClick={c.refreshCode}>{t("phone.code.createNew")}</button>
    </div>;
  }
  if (c.phase === "qr" && c.pairingLink && c.state) {
    const code = c.state.e2e?.enabled ? null : pairing?.code ?? null;
    return <PhoneCodeCard link={c.pairingLink} code={code} expiresAt={pairing?.expiresAt ?? null} connected={null}
      noCode={<span data-pair-encrypted="" className="text-[13px] leading-[18px] text-ink-secondary">{t("devicesPage.addFlow.encryptedNoType")}</span>}>
      <CopyPhoneLink link={c.pairingLink} />
      <p data-pair-reach="" className="text-[12px] leading-4 text-ink-secondary">{reachLine(c.state)}</p>
      {/* With the relay or an HTTPS address in the code the phone pairs through it whatever a firewall says. */}
      {wifiOnlyCode(c.state) && <HostFirewallNote state={c.state} className="" />}
    </PhoneCodeCard>;
  }
  return <PhoneSetupFlowView controller={c} />;
}
