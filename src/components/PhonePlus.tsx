// The + menu with where the bot works when there is a choice: the phone composer's round +, Simple mode's dock + and Advanced mode's quiet + (Composer.tsx).
import type { ComponentProps } from "react";

import { ComposerPlusMenu } from "./ComposerPlusMenu";
import { usePlaceMenuItem } from "./PlaceChip";

type PhonePlusProps = Pick<ComponentProps<typeof ComposerPlusMenu>, "onAttach" | "goal" | "teach" | "approval" | "callBotId" | "quiet" | "circle">;

function PhonePlusWithPlace({ place, ...rest }: PhonePlusProps & { place: Parameters<typeof usePlaceMenuItem>[0] }) {
  const item = usePlaceMenuItem(place);
  return <ComposerPlusMenu {...rest} extraItems={[item]} />;
}

/** The + with everything the composer keeps out of sight: attach, Finish together, where the bot works, approval level and call mode. */
export function PhonePlus({ place, quiet, circle = !quiet, ...rest }: PhonePlusProps & { place?: Parameters<typeof usePlaceMenuItem>[0] }) {
  return place ? <PhonePlusWithPlace place={place} quiet={quiet} circle={circle} {...rest} /> : <ComposerPlusMenu {...rest} circle={circle} quiet={quiet} />;
}
