import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { withOpenSettings } from "@/components/OpenSystemSettings";
import { t } from "./i18n";

export function useComposerDictation({ draftId, text, onText, available }: {
  draftId: string;
  text: string;
  onText: (text: string) => void;
  available: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<ReactNode>(null);
  const draft = useRef({ id: draftId, text });
  draft.current = { id: draftId, text };
  const session = useRef({ draftId: "", base: "" });
  const cancel = useRef<(() => void) | null>(null);
  const stop = useCallback(() => {
    cancel.current?.();
    setRecording(false);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const bridge = window.ogb;
    if (!bridge || session.current.draftId !== draftId) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const base = session.current.base;
    let lastText = base;
    let active = true;
    const cancelSession = () => {
      if (!active) return;
      active = false;
      void bridge.speechStop();
      setRecording(false);
    };
    cancel.current = cancelSession;
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (!active || draft.current.id !== draftId) return;
      if (draft.current.text !== lastText) {
        cancelSession();
        return;
      }
      if (typeof line.text !== "string" || !line.text.trim()) return;
      lastText = base ? `${base}${/\s$/.test(base) ? "" : " "}${line.text}` : line.text;
      draft.current.text = lastText;
      onText(lastText);
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason }) => {
      if (!active || draft.current.id !== draftId) return;
      active = false;
      setRecording(false);
      if (code === 2) {
        setSpeechError(t("composer.dictation.macOnly"));
      } else if (code === 1) {
        // A refused permission comes with a way to the pane that grants it.
        setSpeechError(reason === "speech-not-authorized" ? withOpenSettings(t("composer.dictation.permission"), "speech")
          : t(reason === "dictation-disabled" ? "composer.dictation.disabled" : "composer.dictation.failed"));
      }
    });
    void bridge.speechStart().catch(() => {
      if (!active) return;
      cancelSession();
      setSpeechError(t("composer.dictation.failed"));
    });
    return () => {
      if (cancel.current === cancelSession) cancel.current = null;
      offTranscript();
      offEnd();
      if (active) {
        active = false;
        void bridge.speechStop();
      }
    };
  }, [recording, draftId, onText]);

  const toggle = () => {
    if (!available || !window.ogb) {
      setSpeechError(t("composer.dictation.unavailable"));
    } else if (recording) {
      stop();
    } else {
      session.current = { draftId, base: text };
      setRecording(true);
    }
  };
  return { recording, speechError, toggle, stop };
}
