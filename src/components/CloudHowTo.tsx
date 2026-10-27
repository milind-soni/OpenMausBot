import { useEffect, useState } from "react";
import { track } from "@/lib/analytics";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { NoticeToast } from "./NoticeCard";
import { Spotlight } from "./onboarding/Spotlight";

export const SWITCHER_ANCHOR = "server-switcher";

export function switcherPlacement(doc: Pick<Document, "querySelectorAll"> = document, width = window.innerWidth, height = window.innerHeight): "below" | "right" | null {
  const shown = Array.from(doc.querySelectorAll<HTMLElement>(`[data-tour="${SWITCHER_ANCHOR}"]`)).map(element => element.getBoundingClientRect())
    .find(rect => rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < width && rect.bottom > 0 && rect.top < height);
  if (!shown) return null;
  return shown.width < 80 ? "right" : "below";
}

export function CloudHowTo() {
  const { state, dispatch } = useStore();
  const [placement, setPlacement] = useState<"below" | "right" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const open = state.cloudHowTo;
  useEffect(() => {
    if (!open) return;
    const found = switcherPlacement();
    if (found) { setPlacement(found); return; }
    track("cloud_howto", { result: "no_button" });
    dispatch({ type: "openCloudAdd", source: "app_howto" });
    setToast(t("cloudHowTo.nextTime"));
  }, [open, dispatch]);
  if (toast) return <NoticeToast text={toast} onDone={() => setToast(null)} />;
  if (!open || !placement) return null;
  const skip = () => { track("cloud_howto", { result: "skipped" }); dispatch({ type: "cloudHowTo", open: false }); };
  return <Spotlight anchor={SWITCHER_ANCHOR} placement={placement} mascot="curious" secondary={{ label: t("cloudHowTo.skip"), onClick: skip }} onDone={skip}>
    <p className="font-semibold">{t("cloudHowTo.title")}</p>
    <p className="mt-1 text-[13px] text-ink-secondary">{t("cloudHowTo.body")}</p>
  </Spotlight>;
}
