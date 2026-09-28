// Desktop capabilities with dictation upgraded for the universal engine, and
// the engine's view of STT settings kept current. Drop-in for
// useDesktopCapabilities() wherever a component decides whether it can listen.
import { useEffect, useMemo } from "react";

import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { useStore } from "@/state/store";
import { effectiveDictation, setSttStatus } from "./bridge";

export function useSpeechCapabilities() {
  const { state } = useStore();
  const desktop = useDesktopCapabilities();
  const stt = state.config?.stt;
  useEffect(() => setSttStatus(stt), [stt]);
  const capabilities = useMemo(
    () => ({ ...desktop.capabilities, dictation: effectiveDictation(desktop.capabilities.dictation, stt) }),
    [desktop.capabilities, stt],
  );
  return { ...desktop, capabilities };
}
