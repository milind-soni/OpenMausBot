import { t } from "@/lib/i18n";
import { productName } from "../lib/brand";
import type { TailnetShareState } from "../lib/companion-types";
import { usePhoneSetupController, type CompanionState, type PhoneSetupController } from "./PhoneSetupFlow";
import { deriveTailscalePairingStatus, type TailscalePairingStatus } from "./PhoneDevicesSection";
import { useStore } from "@/state/store";
import { ServerPairingCard } from "./ServerPairingCard";
import { SettingRow, SettingsGroup, SettingsRows, Switch } from "./SettingsPrimitives";

/** What the row says about the share right now; null while it is off. */
export function tailnetShareLine(share: TailnetShareState | undefined): string | null {
  if (!share?.on) return null;
  if (!share.origin) return t("devices.computers.waiting", { app: productName() });
  return t(share.https ? "devices.computers.https" : "devices.computers.http", { address: share.origin });
}

/** Why Tailscale is not ready, in the Tailscale check's own words; null while it is off, or on and fine. */
function tailscaleTrouble(status: TailscalePairingStatus): string | null {
  if (status.kind !== "not-installed" && status.kind !== "signed-out" && status.kind !== "magicdns") return null;
  return status.detail ? `${status.title} ${status.detail}` : status.title;
}

/** Your other computers: lets them open this one over Tailscale, and makes them a pairing link. */
export function TailnetComputers({ c, state, blocked, simple, status }: { c: PhoneSetupController; state: CompanionState; blocked: string | null; simple: boolean; status: TailscalePairingStatus }) {
  const on = state.routes?.tailscale?.on === true && state.routes.tailscale.computers === true;
  const trouble = tailscaleTrouble(status);
  // On with nothing answering: Tailscale's own reason says what to fix; "isn't connected yet" is only for when it gives none.
  const line = on && !(trouble && !state.tailnetShare?.origin) ? tailnetShareLine(state.tailnetShare) : null;
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
                onClick={() => void c.act((companion) => companion.setTailscaleComputers?.(!on) ?? companion.state())} />
            </span>
          </SettingRow>
        </SettingsRows>
      </SettingsGroup>
      {address && <ServerPairingCard simple={simple} reveal={false} forComputer address={address} />}
    </>
  );
}

/** The same row wherever it is shown outside its Settings page: its own link to the app, the organization's policy and Tailscale's state. */
export function OtherComputersSetting({ simple = true }: { simple?: boolean }) {
  const c = usePhoneSetupController(useStore().state.config?.profile?.email);
  const policy = useStore().state.config?.managedPolicy;
  if (!c.state) return null;
  const blocked = policy?.remoteAccess === false ? t("policy.managedBy", { organization: policy.organizationName }) : null;
  return <TailnetComputers c={c} state={c.state} blocked={blocked} simple={simple} status={deriveTailscalePairingStatus(c.state)} />;
}
