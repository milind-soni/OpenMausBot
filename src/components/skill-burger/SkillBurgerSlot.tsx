import { useMemo, useState } from "react";

import { askOf, burgerLayers, BURGER_MIN_LAYERS, type RunMessage } from "../../../shared/skill-burger/layers";
import { layerLine, SkillBurger } from "./SkillBurger";

/** The chat dock's burger: the run since the person's last ask, once it has two real steps, until it is closed. */
export function SkillBurgerSlot({ botId, threadId, busy, canWrite, messages, liveTools, transcriptKey }: {
  botId: string;
  threadId: string;
  busy: boolean;
  canWrite: boolean;
  messages: readonly RunMessage[];
  liveTools: ReadonlySet<string>;
  transcriptKey: string;
}) {
  const layers = useMemo(() => burgerLayers(messages, liveTools), [messages, liveTools]);
  const [closed, setClosed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const run = layers[0]?.messageId;
  if (!run || layers.length < BURGER_MIN_LAYERS || closed.get(transcriptKey) === run) return null;
  const summary = askOf(messages) ?? layers.map(layerLine).join(", ");
  return (
    <div className="flex justify-end px-4 pb-2">
      <SkillBurger
        key={`${transcriptKey}:${run}`}
        layers={layers}
        summary={summary.slice(0, 160)}
        canSave={canWrite && !busy}
        botId={botId}
        threadId={threadId}
        onDismiss={() => setClosed((current) => new Map(current).set(transcriptKey, run))}
      />
    </div>
  );
}
