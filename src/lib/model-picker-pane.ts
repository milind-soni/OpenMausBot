import { useEffect, useRef, useState } from "react";

export type PickerPane = "main" | "custom";

export interface PickerPaneInput {
  /** The engine on the picker's rail, and the rail pick that put it there (null: the bot's own engine). */
  instanceId: string | undefined;
  railId: string | null;
  /** The engine lists models of its own (a plan account counts before it signs in). */
  hasOfficialModels: boolean;
  /** The engine runs local models only. */
  customOnly: boolean;
  /** The bot's model on this engine is a local one. */
  selectedIsCustom: boolean;
  /** The picker is open and reading the engine list. */
  reading: boolean;
}

/** Which pane the model picker shows for the engine on its rail: the engine's own models ("main") or local ones.
 * Engines read their model lists lazily, so a picker can open before its engine has listed anything: while that read
 * runs it shows the engine's pane as loading, never "no local models", and once the engine's own models arrive it
 * moves back to them from the local pane it fell to, unless the bot runs a local model. */
export function usePickerPane(input: PickerPaneInput, onRailChange: () => void) {
  const { instanceId, railId, hasOfficialModels, customOnly, selectedIsCustom, reading } = input;
  const [pane, setPane] = useState<PickerPane>("main");
  const seen = useRef({ instanceId, hasOfficialModels });
  const railChanged = useRef(onRailChange);
  railChanged.current = onRailChange;
  useEffect(() => {
    const before = seen.current;
    seen.current = { instanceId, hasOfficialModels };
    const none = customOnly || !hasOfficialModels;
    if (railId !== null && railId !== instanceId) {
      setPane(none ? "custom" : "main");
      railChanged.current();
    } else if (none) {
      setPane("custom");
    } else if (before.instanceId === instanceId && !before.hasOfficialModels && !selectedIsCustom) {
      setPane("main");
    }
  }, [railId, instanceId, hasOfficialModels, customOnly, selectedIsCustom]);
  const loading = reading && !hasOfficialModels && !customOnly;
  return { pane: loading ? "main" as const : pane, setPane, loading };
}
