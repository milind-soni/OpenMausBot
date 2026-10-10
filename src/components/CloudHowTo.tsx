// Show me how (docs/cloud-pro.md, "Add a Cloud"): one step that lights the
// menu at the top of the sidebar, the one that says This computer, where Add
// a Cloud… lives for good. The person clicks the real menu (the switcher opens
// it as reached from here) and the tip ends when it closes, whatever was
// chosen; Skip or Escape end it too. There is never a second hint. With the
// menu off screen (a closed drawer, a narrow window), the dialog opens instead
// and a line says where the menu is for next time.
import { useEffect, useState } from "react";
import { track } from "@/lib/analytics";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { NoticeToast } from "./NoticeCard";
import { Spotlight } from "./onboarding/Spotlight";

export const SWITCHER_ANCHOR = "server-switcher";

/** The menu button on screen, if any, and where the tip fits beside it. */
export function switcherPlacement(doc: Pick<Document, "querySelectorAll"> = document, width = window.innerWidth, height = window.innerHeight): "below" | "right" | null {
  const shown = Array.from(doc.querySelectorAll<HTMLElement>(`[data-tour="${SWITCHER_ANCHOR}"]`)).map(element => element.getBoundingClientRect())
    .find(rect => rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < width && rect.bottom > 0 && rect.top < height);
  if (!shown) return null;
  // The icons-only sidebar: beside the button; otherwise below it.
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
    <p className="mt-1 text-[12.5px] text-ink-secondary">{t("cloudHowTo.body")}</p>
  </Spotlight>;
}
