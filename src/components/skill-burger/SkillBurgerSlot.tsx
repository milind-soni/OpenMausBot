import { useEffect, useMemo, useState } from "react";

import { askOf, burgerLayers, BURGER_MIN_LAYERS, type RunMessage } from "../../../shared/skill-burger/layers";
import { fetchBurgerSummary } from "@/lib/skill-burger";
import { layerLine, SkillBurger } from "./SkillBurger";

/** The chat dock's burger: the run since the person's last ask, once it has two real steps, until it is closed. Once the
 * run finishes its top bun names what it did; the ask stands in until then. */
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
  const [named, setNamed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const run = layers[0]?.messageId;
  const finished = Boolean(run) && layers.length >= BURGER_MIN_LAYERS && !busy && layers.every((layer) => layer.status !== "running");
  const runKey = run ? `${transcriptKey}:${run}:${layers.length}` : "";

  useEffect(() => {
    if (!finished || !runKey || named.has(runKey)) return;
    let current = true;
    void fetchBurgerSummary(botId, threadId).then((summary) => {
      if (current && summary) setNamed((map) => new Map(map).set(runKey, summary));
    });
    return () => { current = false; };
  }, [finished, runKey, botId, threadId, named]);

  if (!run || layers.length < BURGER_MIN_LAYERS || closed.get(transcriptKey) === run) return null;
  const summary = named.get(runKey) ?? askOf(messages) ?? layers.map(layerLine).join(", ");
  return (
    <div className="flex justify-end px-4 pb-2">
      <SkillBurger
        key={`${transcriptKey}:${run}`}
        run={`${transcriptKey}:${run}`}
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
