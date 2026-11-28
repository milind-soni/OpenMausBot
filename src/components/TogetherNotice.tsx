import { useEffect, useState } from "react";
import { Merge } from "lucide-react";
import { t } from "@/lib/i18n";
import { togetherNoticeDone, togetherNoticeShown } from "@/lib/places-together";
import { NoticeCard, PRIMARY_BUTTON } from "./NoticeCard";
import { TogetherChoice } from "./TogetherChoice";

/** The one-time notice of "This computer and My Cloud together" being on by default (electron/places-together.mjs): a
 * card in the corner, like every other notice, that never takes focus or waits for an answer. Drawing it is what turns the
 * default on (main does nothing before). It carries the choice (TogetherChoice) What's new's slide carries too, and shows
 * where that slide could not: a launch What's new does not show in. Got it, the close button, Escape or either switch,
 * and it never shows again. */
export function TogetherNotice({ onClose }: { onClose: () => void }) {
  // Told once per notice on screen (a kept object, not a ref: notices are also drawn outside a live tree in tests).
  const [told] = useState(() => ({ current: false }));
  useEffect(() => {
    if (told.current) return;
    told.current = true;
    void togetherNoticeShown();
  }, []);
  const done = () => { togetherNoticeDone(); onClose(); };
  return <NoticeCard titleId="together-notice-title" notice="together-default" icon={Merge} title={t("together.notice.title")} onDismiss={done}>
    <p className="mb-3 mt-1 text-[13px] text-ink-secondary">{t("together.notice.body")}</p>
    <TogetherChoice />
    <button type="button" data-together-notice-done className={PRIMARY_BUTTON} onClick={done}>{t("together.notice.done")}</button>
  </NoticeCard>;
}
