import { useEffect, useMemo, useState } from "react";

import { askOf, burgerLayers, burgerWorthy, type RunMessage } from "../../../shared/skill-burger/layers";
import { latestRun, runView } from "../../../shared/skill-burger/run-view";
import { fetchBurgerDraft, fetchBurgerSummary, useRunnable, type DraftView } from "@/lib/skill-burger";
import { RunBurger } from "./RunBurger";
import { layerLine, SkillBurger } from "./SkillBurger";

/** The turn's change to a saved burger's steps, if it made one: the burger's name and the change's Undo. */
export function editIn(messages: readonly RunMessage[]): { id: string; name: string; undo: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && message.kind === "text") return null;
    if (message.kind !== "activity" || !/(?:^|__)workflow_edit$/.test(message.tool?.name ?? "") || message.tool?.ok === false) continue;
    const undo = /undo \\?"([0-9a-f-]{36})\\?"/.exec(message.tool?.output ?? "")?.[1];
    let name: unknown;
    try { name = (JSON.parse(message.tool?.input ?? "{}") as { name?: unknown }).name; } catch { name = undefined; }
    if (undo && typeof name === "string") return { id: message.id, name, undo };
  }
  return null;
}

/** The chat dock's burger. While a saved Skill Burger runs (or right after the turn changed one), its steps as the run
 * goes; else the run since the person's last ask, once it has two real steps, ready to save. Either stays until closed. */
export function SkillBurgerSlot({ botId, threadId, busy, canWrite, messages, liveTools, transcriptKey }: {
  botId: string;
  threadId: string;
  busy: boolean;
  canWrite: boolean;
  messages: readonly RunMessage[];
  liveTools: ReadonlySet<string>;
  transcriptKey: string;
}) {
  const seen = useMemo(() => latestRun(messages, liveTools), [messages, liveTools]);
  const edit = useMemo(() => (seen ? null : editIn(messages)), [seen, messages]);
  const runnable = useRunnable(seen?.name ?? edit?.name ?? null, botId);
  const layers = useMemo(() => burgerLayers(messages, liveTools), [messages, liveTools]);
  const [closed, setClosed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [named, setNamed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [drafts, setDrafts] = useState<ReadonlyMap<string, DraftView | null>>(() => new Map());
  const run = layers[0]?.messageId;
  const finished = !seen && Boolean(run) && burgerWorthy(layers) && !busy && layers.every((layer) => layer.status !== "running");
  const runKey = run ? `${transcriptKey}:${run}:${layers.length}` : "";

  useEffect(() => {
    if (!finished || !runKey || named.has(runKey)) return;
    let current = true;
    void fetchBurgerSummary(botId, threadId).then((summary) => {
      if (current && summary) setNamed((map) => new Map(map).set(runKey, summary));
    });
    return () => { current = false; };
  }, [finished, runKey, botId, threadId, named]);

  // The finished run as it would be saved, from the server: the card explains it from this once it arrives.
  useEffect(() => {
    if (!finished || !runKey || drafts.has(runKey)) return;
    let current = true;
    void fetchBurgerDraft(botId, threadId).then((draft) => {
      if (current) setDrafts((map) => new Map(map).set(runKey, draft));
    });
    return () => { current = false; };
  }, [finished, runKey, botId, threadId, drafts]);

  const close = (key: string) => () => setClosed((current) => new Map(current).set(transcriptKey, key));
  if (seen || edit) {
    const key = seen ? `run:${seen.run}` : `edit:${edit!.id}`;
    if (!runnable || closed.get(transcriptKey) === key) return null;
    const view = runView(runnable.workflow, seen, seen?.name ?? edit!.name);
    return (
      <div className="flex justify-end px-4 pb-2">
        <RunBurger key={key} view={view} summary={runnable.workflow.summary} botId={botId} threadId={threadId} busy={busy}
          onDismiss={close(key)} {...(edit ? { edited: { undo: edit.undo } } : {})} />
      </div>
    );
  }
  // The pill shows from the first step while the bot works; a run that ends with too little to keep goes.
  if (!run || !(burgerWorthy(layers) || (busy && layers.length > 0)) || closed.get(transcriptKey) === run) return null;
  const summary = named.get(runKey) ?? askOf(messages) ?? layers.map(layerLine).join(", ");
  return (
    <div className="flex justify-end px-4 pb-2">
      <SkillBurger
        key={`${transcriptKey}:${run}`}
        run={`${transcriptKey}:${run}`}
        layers={layers}
        draft={finished ? drafts.get(runKey) ?? null : null}
        summary={summary.slice(0, 160)}
        canSave={canWrite && !busy}
        busy={busy}
        botId={botId}
        threadId={threadId}
        onDismiss={close(run)}
      />
    </div>
  );
}
