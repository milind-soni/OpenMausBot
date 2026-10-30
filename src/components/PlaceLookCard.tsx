import { useState } from "react";
import type { CloudSwatch } from "../../electron/cloud-list.mjs";
import type { PlaceColorOutcome } from "../../electron/place-look.mjs";
import { t } from "@/lib/i18n";
import { choosePlaceColor, usePlaceLook } from "@/lib/place-look";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore } from "@/state/store";
import { PlacePicture } from "./PlacePicture";
import { SettingRow, SettingsRows, SIMPLE_BUTTONS } from "./SettingsPrimitives";
import { SwatchRadios } from "./SwatchRadios";

/** The sidebar's look, as two rows of Settings: its colour, in the six swatches the rail's circles use, and its picture,
 * kept on the place's own server for everyone there. Both start plain. This computer's colour is the app's own; a
 * Cloud's is the Admin's, so every app of theirs follows it, and a team member sees both and who may change them. A
 * browser knows no colour, only the picture. */
export function PlaceLookRows() {
  const look = usePlaceLook();
  const { state } = useStore();
  const admin = useOwnerOrAdmin() === true;
  const computer = window.ogb?.app?.ownPage === true;
  const [pending, setPending] = useState<CloudSwatch | null>(null);
  const [outcome, setOutcome] = useState<PlaceColorOutcome | null>(null);
  const locked = look?.change === null;
  const choose = (swatch: CloudSwatch) => {
    if (!look || locked || pending || swatch === look.swatch) return;
    setPending(swatch); setOutcome(null);
    void choosePlaceColor(swatch).then((answer) => { setPending(null); setOutcome(answer); });
  };
  const note = look?.reason === "member" || outcome === "refused" ? t("placeLook.member") : look?.reason === "signed-out" ? t("placeLook.signedOut")
    : outcome === "unsupported" ? t("placeLook.unsupported") : null;
  return <>
    {look && <div data-place-look={look.change ?? "locked"}>
      <SettingRow title={t("placeLook.sidebarColor")} subtitle={computer ? t("placeLook.sidebarColorSub") : t("placeLook.sub", { name: look.name })}
        message={outcome === "failed" ? <p role="alert" className="text-danger">{t("placeLook.failed")}</p> : note && <p className="text-ink-secondary">{note}</p>}>
        <SwatchRadios value={pending ?? look.swatch} onChange={choose} label={computer ? t("placeLook.sidebarColor") : t("placeLook.aria", { name: look.name })}
          disabled={locked} offset="menu" none />
      </SettingRow>
    </div>}
    <PlacePicture banner={state.config?.workspaceBanner ?? null} canChange={admin} subtitle={t(computer ? "placeLook.sidebarPictureSub" : "placeLook.pictureSub")} />
  </>;
}

/** The same rows in a card of their own, in the Simple look in Advanced too. */
export function PlaceLookCard() {
  return <div data-sidebar-look data-settings-look="simple" className={SIMPLE_BUTTONS}>
    <SettingsRows><PlaceLookRows /></SettingsRows>
  </div>;
}
