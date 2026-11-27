import { useState } from "react";
import { t } from "@/lib/i18n";
import { setPlacesTogether, setTogetherCommands, togetherNoticeDone, usePlacesTogether } from "@/lib/places-together";
import { Switch } from "./SettingsPrimitives";

/** The choice the notice of "This computer and My Cloud together" offers, wherever it is shown (the corner notice, What's
 * new's slide): its first switch turns the joining off at once (back to two separate lists); its second is "Let your Clouds'
 * bots run commands on this computer", as lending says it now, never turned on for them, and turned on only after the same
 * question the OpenMausBot icon's menu asks. Either switch ends the notice for good. `id` keeps its labels apart from any
 * other copy's. */
export function TogetherChoice({ id = "together-notice" }: { id?: string }) {
  const together = usePlacesTogether();
  // Lending's own word, live while the choice is up (also when the icon's menu changes it); while the person's own turn
  // waits on the icon's question, the switch shows where they turned it.
  const [turning, setTurning] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"list" | "commands" | null>(null);
  const [failed, setFailed] = useState(false);
  const [touched, setTouched] = useState(false);
  // My Cloud as home: main says so only while the notice is due, which What's new's slide ends as it is shown.
  const [kept] = useState(() => ({ home: false }));
  if (together?.profileHome) kept.home = true;
  const commands = turning ?? (typeof together?.commands === "boolean" ? together.commands : null);
  // Until the person turns it, the notice's own drawing is turning it on: never shown off for the moment main takes.
  const on = touched ? together?.on === true : together?.on !== false || together?.notice === true;
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
  return <>
    {kept.home && <p data-together-notice-background className="-mt-2 mb-3 text-[12px] leading-snug text-ink-secondary">{t("together.notice.background")}</p>}
    <div className="mb-3 flex flex-col gap-2.5">
      <label className="flex items-center justify-between gap-3 text-[13px] text-ink">
        <span id={`${id}-list`}>{t("together.notice.list")}</span>
        <Switch data-together-notice-list checked={on} disabled={busy !== null} aria-labelledby={`${id}-list`} onClick={turnList} />
      </label>
      {on && <div className="flex flex-col gap-1">
        <label className="flex items-center justify-between gap-3 text-[13px] text-ink">
          <span id={`${id}-commands`}>{t("together.notice.commands")}</span>
          <Switch data-together-notice-commands checked={commands === true} disabled={busy !== null || commands === null} aria-labelledby={`${id}-commands`} onClick={turnCommands} />
        </label>
        <p className="text-[12px] leading-snug text-ink-secondary">{t(commands ? "together.notice.commandsOn" : "together.notice.commandsOff")}</p>
      </div>}
      {!on && <p data-together-notice-off className="text-[12px] leading-snug text-ink-secondary">{t("together.notice.off")}</p>}
    </div>
    {failed && <p role="alert" className="mb-3 text-[12px] text-danger">{t("together.switch.failed")}</p>}
  </>;
}
