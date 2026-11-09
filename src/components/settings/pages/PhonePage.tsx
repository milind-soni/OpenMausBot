import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { t } from "@/lib/i18n";
import { currentPhonePairingTarget } from "@/lib/phone-pairing";
import { useStore } from "@/state/store";
import { PhoneDevicesSection } from "../../PhoneDevicesSection";
import { PlaceMark } from "../../PlacesRail";
import { PlaceBadge } from "../SettingsNav";
import { ServerPairingCard } from "../../ServerPairingCard";
import { SettingsGroup, SettingsLinkRow, SettingsRows } from "../../SettingsPrimitives";
import { useCloudPhoneDestination } from "../../SidebarProfileMenu";
import { useOtherPlaces } from "../settings-context";
import { useSettingsShell } from "../settings-shell";

/** This computer's door to pairing with My Cloud: My Cloud opens with its pairing dialog and code. */
function PairWithCloud() {
  const { cloud, bridge } = useCloudPhoneDestination(true);
  const others = useOtherPlaces();
  const [failed, setFailed] = useState(false);
  if (cloud !== "ready" || !bridge) return null;
  const home = others.find((place) => place.kind === "cloud") ?? null;
  const name = home?.name || t("cloudSetup.myCloud");
  return (
    <div data-settings-block="pair-cloud" className="flex flex-col gap-2">
      <SettingsRows icons>
        <button type="button" data-pair-with-cloud="" onClick={() => { setFailed(false); void bridge.connectHomeForPhone().catch(() => setFailed(true)); }}
          className="flex min-h-16 w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-menu-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
          <span className="flex size-8 shrink-0 items-center justify-center">
            <PlaceMark place={{ kind: "cloud", name, color: home?.color ?? null }} size={24} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[14px] leading-5 text-ink">{t("phone.pair.withPlace", { place: name })}</span>
            <span className="text-[13px] leading-[18px] text-ink-secondary">{t("phone.pair.withPlaceLine", { place: name })}</span>
          </span>
          <ArrowUpRight size={12} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
        </button>
      </SettingsRows>
      {failed && <p role="alert" className="px-4 text-[12px] leading-4 text-danger">{t("cloudPhone.failed")}</p>}
    </div>
  );
}

/** The phones of the person's other places, one row each. A place already offered by the "Pair with My Cloud" callout at
 * the top is left out, so one screen never has two doors to the same place. */
function OtherPlaces() {
  const { ctx } = useSettingsShell();
  const { cloud, bridge } = useCloudPhoneDestination(ctx.here);
  const callout = ctx.here && cloud === "ready" && Boolean(bridge);
  const others = useOtherPlaces("phone").filter((place) => !(callout && place.kind === "cloud"));
  if (!ctx.desktop || ctx.client || others.length === 0) return null;
  return (
    <SettingsGroup label={t("settings.otherPlaces")} block="other-places">
      <SettingsRows icons>
        {others.map((place) => (
          <SettingsLinkRow key={place.key} title={place.name} subtitle={t("phone.otherPlace.line", { place: place.name })}
            leading={<PlaceBadge place={{ kind: place.kind === "computer" ? "computer" : "cloud", name: place.name, color: place.color }} size={24} />}
            external onClick={place.open} data={{ "data-other-place": place.key }} />
        ))}
      </SettingsRows>
    </SettingsGroup>
  );
}

export function PhonePage() {
  const { ctx, place } = useSettingsShell();
  const { state } = useStore();
  const focus = state.appSettingsPhonePairing;
  const computerPairs = currentPhonePairingTarget(ctx.cloud) === "computer";
  const card = <ServerPairingCard cloudHome={ctx.cloud} focusRequest={computerPairs ? 0 : focus} team={state.config?.team?.name} placeName={place.name} simple={!ctx.advanced}
    teamPhoneBlocked={state.config?.managedPolicy?.remoteAccess === false ? t("policy.teamRemoteBlocked", { organization: state.config.managedPolicy.organizationName }) : null} />;
  return <>
    {ctx.here
      ? <>
          <PhoneDevicesSection profileEmail={state.config?.profile?.email} focusRequest={focus} simple={!ctx.advanced} placeName={place.name} top={<PairWithCloud />} />
          {card}
        </>
      : card}
    <OtherPlaces />
  </>;
}
