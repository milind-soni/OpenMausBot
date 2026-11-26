// The ＋ menu's New bot, with "This computer and My Cloud together" on: it asks one thing, where the bot lives. The menu's
// own item names the place on screen; the item here is the other place, which makes the bot itself once main has opened it.
import { useEffect, useState } from "react";
import { Bot as BotIcon, Cloud } from "lucide-react";
import { t } from "@/lib/i18n";
import { aiLabel, newBotDifference, newBotInOtherPlace, readNewBotChoice, usePlacesTogether, type BotHome, type NewBotChoice } from "@/lib/places-together";
import type { InstanceInfo } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";
import { engineReady, providerName } from "./EngineLibrary";
import { SIMPLE_MENU_META } from "./menu-recipe";

const label = (home: BotHome): string => t(home === "cloud" ? "sidebar.newBotOn.cloud" : "sidebar.newBotOn.computer");
const list = (names: readonly string[]): string => new Intl.ListFormat(undefined, { style: "short", type: "conjunction" }).format(names);

const engineName = (kind: string): string => providerName({ driverKind: kind } as InstanceInfo);

/** An AI a new bot could run on: installed and signed in, never one that only works through free no-login models. The
 * same rule main applies to the other place's AIs. */
export const readyForNewBot = (instance: InstanceInfo): boolean => engineReady(instance) && instance.snapshot.freeFallback !== true;

function differenceLine(hereAis: readonly string[], choice: NewBotChoice | null): string | null {
  const differs = newBotDifference(hereAis, choice && { ...choice, ais: choice.ais?.map((ai) => aiLabel(ai.name, ai.kind, engineName)) ?? null });
  if (!differs) return null;
  if (differs.kind === "asleep") return t("sidebar.newBotOn.asleep");
  if (differs.kind === "noAi") return t("sidebar.newBotOn.noAi");
  return [differs.onlyThere.length ? t("sidebar.newBotOn.onlyThere", { ais: list(differs.onlyThere) }) : "",
    differs.onlyHere.length ? t("sidebar.newBotOn.onlyHere", { ais: list(differs.onlyHere) }) : ""].filter(Boolean).join(" ");
}

/** The New bot item's words while the ＋ asks where: it names the place on screen. Null with the switch off. */
export function useNewBotHereLabel(): string | null {
  const together = usePlacesTogether();
  return together?.on && together.other ? label(together.here) : null;
}

/** The ＋'s second New bot item, for the other place, with the one line that says what differs there. */
export function NewBotOtherPlaceItem({ itemClass, onClose }: { itemClass: string; onClose(): void }) {
  const together = usePlacesTogether();
  const other = together?.on ? together.other?.home ?? null : null;
  const hereAis = useStoreSelector((state) => state.instances.filter(readyForNewBot).map((instance) => aiLabel(instance.displayName, instance.driverKind, engineName)), (a, b) => a.join("\n") === b.join("\n"));
  const [choice, setChoice] = useState<NewBotChoice | null>(null);
  useEffect(() => {
    if (!other) return;
    let alive = true;
    void readNewBotChoice().then((next) => { if (alive) setChoice(next); });
    return () => { alive = false; };
  }, [other]);
  if (!other) return null;
  const unable = together?.other?.newBot === false;
  const line = unable ? t("sidebar.newBotOn.needsUpdate") : differenceLine(hereAis, choice);
  return (
    <button type="button" role="menuitem" data-new-bot-home={other} disabled={unable} className={`${itemClass} disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent`}
      onClick={() => { onClose(); newBotInOtherPlace(); }}>
      {other === "cloud" ? <Cloud size={16} className="shrink-0 text-ink-secondary" /> : <BotIcon size={16} className="shrink-0 text-ink-secondary" />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{label(other)}</span>
        {line && <span data-new-bot-differs="" className={`${SIMPLE_MENU_META} whitespace-normal`}>{line}</span>}
      </span>
    </button>
  );
}
