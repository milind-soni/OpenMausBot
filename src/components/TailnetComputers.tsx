import { t } from "@/lib/i18n";
import { productName } from "../lib/brand";
import type { CompanionBridge, TailnetShareState } from "../lib/companion-types";
import type { CompanionState, PhoneSetupController } from "./PhoneSetupFlow";
import { setCompanionTailscale, type TailscalePairingStatus } from "./PhoneDevicesSection";
import { ServerPairingCard } from "./ServerPairingCard";
import { SettingRow, SettingsGroup, SettingsRows, Switch } from "./SettingsPrimitives";

/** What the row says about the share right now; null while it is off. */
export function tailnetShareLine(share: TailnetShareState | undefined): string | null {
  if (!share?.on) return null;
  if (!share.origin) return t("devices.computers.waiting", { app: productName() });
  return t(share.https ? "devices.computers.https" : "devices.computers.http", { address: share.origin });
}

/** Turning the share on turns Tailscale on first; a Tailscale that cannot start leaves the share off, with its reason in the state. */
export async function setComputerShare(companion: CompanionBridge, state: Pick<CompanionState, "routes">, on: boolean): Promise<CompanionState> {
  if (on && state.routes?.tailscale?.on !== true) {
    const next = await setCompanionTailscale(companion, true);
    if (next.routes?.tailscale?.on !== true) return next;
  }
  return companion.setTailscaleComputers?.(on) ?? companion.state();
}

/** Why Tailscale is not ready, in the Tailscale check's own words; null while it is off, or on and fine. */
function tailscaleTrouble(status: TailscalePairingStatus): string | null {
  if (status.kind !== "not-installed" && status.kind !== "signed-out" && status.kind !== "magicdns") return null;
  return status.detail ? `${status.title} ${status.detail}` : status.title;
}

/** Your other computers: lets them open this one over Tailscale, and makes them a pairing link. */
export function TailnetComputers({ c, state, blocked, simple, status }: { c: PhoneSetupController; state: CompanionState; blocked: string | null; simple: boolean; status: TailscalePairingStatus }) {
  const on = state.routes?.tailscale?.on === true && state.routes.tailscale.computers === true;
  const line = on ? tailnetShareLine(state.tailnetShare) : null;
  const trouble = tailscaleTrouble(status);
  const address = on ? state.tailnetShare?.origin ?? null : null;
  return (
    <>
      <SettingsGroup block="computers">
        <SettingsRows>
          <SettingRow title={t("devices.computers.title")} subtitle={t("devices.computers.detail")}
            message={line || trouble || blocked ? <span data-tailnet-share={line ? "" : undefined} data-tailnet-trouble={!line && trouble ? status.kind : undefined} className="break-words" aria-live="polite">{line ?? trouble ?? blocked}</span> : undefined}>
            <span data-route-row="tailscale-computers" className="contents">
              {!on && status.kind === "not-installed" && <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className="ui-button">{t("remote.tailscale.getIt")}</a>}
              <Switch checked={on} aria-label={t("devices.computers.title")} disabled={c.busy || c.accountBusy || (Boolean(blocked) && !on)} title={blocked ?? undefined}
                onClick={() => void c.act((companion) => setComputerShare(companion, state, !on))} />
            </span>
          </SettingRow>
        </SettingsRows>
      </SettingsGroup>
      {address && <ServerPairingCard simple={simple} reveal={false} forComputer address={address} />}
    </>
  );
}
