import { useEffect } from "react";
import { holdAppSounds } from "@/lib/app-sounds";
import { useReportCallPresence } from "@/lib/call-presence";
import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import { handleLiveCallKey, onLiveStreamConnected, onServerCall } from "@/lib/live-call-media";
import { useStore } from "@/state/store";

export function LiveCallHost() {
  const { state } = useStore();
  useReportCallPresence();
  useEffect(() => onServerCall(state.liveCall), [state.liveCall]);
  const onCall = Boolean(state.liveCall && state.liveCall.status !== "ended");
  useEffect(() => (onCall ? holdAppSounds("call") : undefined), [onCall]);
  useEffect(() => onLiveStreamConnected(state.connected), [state.connected]);
  useEffect(() => {
    const isMac = isMacPlatform();
    const onKey = (event: KeyboardEvent) => {
      if (handleLiveCallKey(event, isMac)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
