import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { withOpenSettings } from "@/components/OpenSystemSettings";
import { useStore } from "@/state/store";
import { t } from "./i18n";
import { recordedSpeech } from "./recorded-speech";
import { listensHere, speechBridge } from "./speech";

export function useComposerDictation({ draftId, text, onText }: {
  draftId: string;
  text: string;
  onText: (text: string) => void;
}) {
  const { capabilities } = useDesktopCapabilities();
  const config = useStore().state.config;
  const bridge = speechBridge(config);
  const ready = listensHere(capabilities, config);
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<ReactNode>(null);
  const draft = useRef({ id: draftId, text });
  draft.current = { id: draftId, text };
  const session = useRef({ draftId: "", base: "" });
  const cancel = useRef<(() => void) | null>(null);
  const finish = useRef<(() => void) | null>(null);
  const stop = useCallback(() => {
    cancel.current?.();
    setRecording(false);
  }, []);

  useEffect(() => {
    if (!recording) return;
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
    finish.current = bridge === recordedSpeech ? () => void recordedSpeech.speechFinish() : null;
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
    const offEnd = bridge.onSpeechEnd(({ code, reason, message }) => {
      if (!active || draft.current.id !== draftId) return;
      active = false;
      setRecording(false);
      if (code === 2) {
        setSpeechError(t("composer.dictation.macOnly"));
      } else if (code === 1) {
        // A refused permission comes with a way to the pane that grants it.
        setSpeechError(message ?? (reason === "speech-not-authorized" ? withOpenSettings(t("composer.dictation.permission"), "speech")
          : t(reason === "dictation-disabled" ? "composer.dictation.disabled" : "composer.dictation.failed")));
      }
    });
    void bridge.speechStart().catch(() => {
      if (!active) return;
      cancelSession();
      setSpeechError(t("composer.dictation.failed"));
    });
    return () => {
      if (cancel.current === cancelSession) cancel.current = null;
      finish.current = null;
      offTranscript();
      offEnd();
      if (active) {
        active = false;
        void bridge.speechStop();
      }
    };
  }, [recording, draftId, onText, bridge]);

  const toggle = () => {
    if (!ready || !speechBridge(config)) {
      setSpeechError(t("composer.dictation.unavailable"));
    } else if (recording) {
      if (finish.current) finish.current();
      else stop();
    } else {
      session.current = { draftId, base: text };
      setRecording(true);
    }
  };
  return { recording, ready, speechError, toggle, stop };
}
