import { t } from "@/lib/i18n";
import { productName } from "@/lib/brand";
import type { CompanionState } from "@/lib/companion-types";

const NOTE = "mt-3 w-full rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-left text-[12px] leading-relaxed text-warning";

/** The command that lets a phone in on the device port; ufw is the only firewall the sidecar reports. */
export const hostFirewallCommand = (port: number) => `sudo ufw allow ${port}/tcp`;

/** Linux: ufw is on and no rule we can read lets the device port in, so a phone on the Wi-Fi may never connect. */
export function HostFirewallNote({ state, className = "" }: { state: Pick<CompanionState, "hostFirewall" | "port">; className?: string }) {
  if (state.hostFirewall !== "ufw" || !Number.isSafeInteger(state.port)) return null;
  return (
    <div role="note" data-host-firewall="" className={`${NOTE} ${className}`}>
      <p>{t("phone.code.hostFirewall", { app: productName() })}</p>
      <code className="mt-1 block select-all font-mono text-[12px] text-ink">{hostFirewallCommand(state.port)}</code>
    </div>
  );
}

/** The Wi-Fi code panel's firewall notes: Windows calls the network Public, or ufw is on. */
export function FirewallNotes({ state }: { state: Pick<CompanionState, "hostFirewall" | "port" | "publicNetwork"> }) {
  return <>
    {state.publicNetwork && <p role="note" className={`${NOTE} max-w-[390px]`}>{t("phone.code.publicNetwork", { network: state.publicNetwork })}</p>}
    <HostFirewallNote state={state} className="max-w-[390px]" />
  </>;
}
