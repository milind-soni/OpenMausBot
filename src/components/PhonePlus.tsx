// The phone composer's round + and Advanced mode's quiet + (Composer.tsx): the + menu, with where the bot works when there is a choice.
import type { ComponentProps } from "react";

import { ComposerPlusMenu } from "./ComposerPlusMenu";
import { usePlaceMenuItem } from "./PlaceChip";

type PhonePlusProps = Pick<ComponentProps<typeof ComposerPlusMenu>, "onAttach" | "goal" | "teach" | "approval" | "callBotId" | "quiet">;

function PhonePlusWithPlace({ place, quiet, ...rest }: PhonePlusProps & { place: Parameters<typeof usePlaceMenuItem>[0] }) {
  const item = usePlaceMenuItem(place);
  return <ComposerPlusMenu {...rest} extraItems={[item]} circle={!quiet} quiet={quiet} />;
}

/** The + with everything the composer keeps out of sight: attach, Finish together, where the bot works, approval level and call mode. */
export function PhonePlus({ place, quiet, ...rest }: PhonePlusProps & { place?: Parameters<typeof usePlaceMenuItem>[0] }) {
  return place ? <PhonePlusWithPlace place={place} quiet={quiet} {...rest} /> : <ComposerPlusMenu {...rest} circle={!quiet} quiet={quiet} />;
}
