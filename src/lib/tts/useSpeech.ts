import { useSyncExternalStore } from "react";

import { speaker, type SpeechSnapshot } from "./index";

export function useSpeech(): SpeechSnapshot {
  return useSyncExternalStore(
    (fn) => speaker.subscribe(fn),
    () => speaker.state,
    () => speaker.state,
  );
}
