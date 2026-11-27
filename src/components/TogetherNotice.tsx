import { useEffect, useState } from "react";
import { Merge } from "lucide-react";
import { t } from "@/lib/i18n";
import { setPlacesTogether, setTogetherCommands, togetherNoticeDone, togetherNoticeShown, usePlacesTogether } from "@/lib/places-together";
import { NoticeCard, PRIMARY_BUTTON } from "./NoticeCard";
import { Switch } from "./SettingsPrimitives";

/** The one-time notice of "This computer and My Cloud together" being on by default (electron/places-together.mjs): a
 * card in the corner, like every other notice, that never takes focus or waits for an answer. Drawing it is what turns the
 * default on (main does nothing before). Its first switch turns the joining off at once (back to two separate lists); its
 * second is "Let your Clouds' bots run commands on this computer", as lending says it now, never turned on for them, and
 * turned on only after the same question the OpenMausBot icon's menu asks. Got
 * it, the close button, Escape or either switch, and it never shows again. */
export function TogetherNotice({ onClose }: { onClose: () => void }) {
  const together = usePlacesTogether();
  // Told once per notice on screen (a kept object, not a ref: notices are also drawn outside a live tree in tests).
  const [told] = useState(() => ({ current: false }));
  // Lending's own word, live while the notice is up (also when the icon's menu changes it); while the person's own turn
  // waits on the icon's question, the switch shows where they turned it.
  const [turning, setTurning] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"list" | "commands" | null>(null);
  const [failed, setFailed] = useState(false);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (told.current) return;
    told.current = true;
    void togetherNoticeShown();
  }, []);
  const commands = turning ?? (typeof together?.commands === "boolean" ? together.commands : null);
  // Until the person turns it, the notice's own drawing is turning it on: never shown off for the moment main takes.
  const on = touched ? together?.on === true : together?.on !== false || together?.notice === true;
  const done = () => { togetherNoticeDone(); onClose(); };
  const turnList = () => {
    if (busy) return;
    setBusy("list"); setFailed(false); setTouched(true);
    togetherNoticeDone();
    void setPlacesTogether(!on, "notice").catch(() => setFailed(true)).finally(() => setBusy(null));
  };
  const turnCommands = () => {
    if (busy) return;
    const next = !(commands ?? false);
    setBusy("commands"); setFailed(false); setTurning(next);
    togetherNoticeDone();
    void setTogetherCommands(next).catch(() => setFailed(true)).finally(() => { setTurning(null); setBusy(null); });
  };
  return <NoticeCard titleId="together-notice-title" notice="together-default" icon={Merge} title={t("together.notice.title")} onDismiss={done}>
    <p className="mb-3 mt-1 text-[13px] text-ink-secondary">{t("together.notice.body")}</p>
    {together?.profileHome && <p data-together-notice-background className="-mt-2 mb-3 text-[12px] leading-snug text-ink-secondary">{t("together.notice.background")}</p>}
    <div className="mb-3 flex flex-col gap-2.5">
      <label className="flex items-center justify-between gap-3 text-[13px] text-ink">
        <span id="together-notice-list">{t("together.notice.list")}</span>
        <Switch data-together-notice-list checked={on} disabled={busy !== null} aria-labelledby="together-notice-list" onClick={turnList} />
      </label>
      {on && <div className="flex flex-col gap-1">
        <label className="flex items-center justify-between gap-3 text-[13px] text-ink">
          <span id="together-notice-commands">{t("together.notice.commands")}</span>
          <Switch data-together-notice-commands checked={commands === true} disabled={busy !== null || commands === null} aria-labelledby="together-notice-commands" onClick={turnCommands} />
        </label>
        <p className="text-[12px] leading-snug text-ink-secondary">{t(commands ? "together.notice.commandsOn" : "together.notice.commandsOff")}</p>
      </div>}
      {!on && <p data-together-notice-off className="text-[12px] leading-snug text-ink-secondary">{t("together.notice.off")}</p>}
    </div>
    {failed && <p role="alert" className="mb-3 text-[12px] text-danger">{t("together.switch.failed")}</p>}
    <button type="button" data-together-notice-done className={PRIMARY_BUTTON} onClick={done}>{t("together.notice.done")}</button>
  </NoticeCard>;
}
