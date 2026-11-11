// The phone composer's round + (Composer.tsx): the + menu, with where the bot works when there is a choice.
import type { ComponentProps } from "react";

import { ComposerPlusMenu } from "./ComposerPlusMenu";
import { usePlaceMenuItem } from "./PlaceChip";

type PhonePlusProps = Pick<ComponentProps<typeof ComposerPlusMenu>, "onAttach" | "goal" | "teach" | "approval" | "callBotId">;

function PhonePlusWithPlace({ place, ...rest }: PhonePlusProps & { place: Parameters<typeof usePlaceMenuItem>[0] }) {
  const item = usePlaceMenuItem(place);
  return <ComposerPlusMenu {...rest} extraItems={[item]} circle />;
}

/** The phone composer's round +: attach, Finish together, where the bot works, approval level and call mode. */
export function PhonePlus({ place, ...rest }: PhonePlusProps & { place?: Parameters<typeof usePlaceMenuItem>[0] }) {
  return place ? <PhonePlusWithPlace place={place} {...rest} /> : <ComposerPlusMenu {...rest} circle />;
}
