import { useEffect } from "react";
import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import { handleLiveCallKey, onLiveStreamConnected, onServerCall } from "@/lib/live-call-media";
import { useStore } from "@/state/store";

/** Feeds the harness's call state and the event stream's health to the
 * app-wide media module, and listens for the Live call chords (mute, hang
 * up) anywhere in the window. Renders nothing. */
export function LiveCallHost() {
  const { state } = useStore();
  useEffect(() => onServerCall(state.liveCall), [state.liveCall]);
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
