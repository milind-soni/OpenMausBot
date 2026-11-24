import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { CallOverlay } from "../../src/components/CallView";
import { Composer } from "../../src/components/Composer";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { GroupCallOverlay } from "../../src/components/GroupCallView";
import { startCall } from "../../src/lib/call";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { setLocale } from "../../src/lib/i18n";
import { wearSkin } from "../../src/lib/skins";
import { StoreProvider, useStore, type Group } from "../../src/state/store";
import { createSpeechTranscript } from "../../electron/speech-transcript.mjs";
import "../../src/styles.css";

setLocale("en");
const params = new URLSearchParams(location.search);
const surface = params.get("surface");
wearSkin(params.get("skin"));

type Line = { text?: string; partial?: boolean; utteranceFinal?: boolean; speechStart?: number };
type SpeechEnd = Parameters<NonNullable<Window["ogb"]>["onSpeechEnd"]>[0];
let normalize = createSpeechTranscript();
const listeners = new Set<(line: Line) => void>();
const oldListeners = new Set<(line: Line) => void>();
const ends = new Set<SpeechEnd>();
let starts = 0;
let stops = 0;
let capturing = false;
window.ogb = {
  platform: "darwin",
  getCapabilities: async () => initialDesktopCapabilities(),
  speechStart: async () => { starts++; capturing = true; normalize = createSpeechTranscript(); },
  speechStop: async () => { stops++; capturing = false; },
  onSpeechTranscript: (cb: (line: Line) => void) => {
    listeners.add(cb);
    oldListeners.add(cb);
    return () => listeners.delete(cb);
  },
  onSpeechEnd: (cb: SpeechEnd) => { ends.add(cb); return () => ends.delete(cb); },
} as unknown as typeof window.ogb;

Object.assign(window, { dictationFixture: {
  stats: () => ({ starts, stops, capturing }),
  hear: (line: Line) => { for (const cb of listeners) cb(normalize(line)); },
  late: (text: string) => { for (const cb of oldListeners) cb({ text, partial: true }); },
  fail: () => {
    capturing = false;
    for (const cb of ends) cb({ code: 1, reason: "dictation-disabled" });
  },
} });

function Fixture() {
  const { state } = useStore();
  const bot = state.bots.find(candidate => !candidate.hidden);
  const room: Group | undefined = bot && {
    id: "dictation-room", threadId: "dictation-room-thread", name: "Launch planning", memberIds: [bot.id],
    defaultResponder: { kind: "member", botId: bot.id }, bulletin: "", unread: false, createdAt: 1, setupCompletedAt: 1, messages: [],
  };
  const callTarget = surface === "bot-call" ? bot?.id : surface === "group-call" ? room?.id : undefined;
  useEffect(() => { if (callTarget) startCall(callTarget); }, [callTarget]);
  return <main className="relative min-h-screen bg-app">
    <div className="mx-auto max-w-xl p-4">
      <h1>Synthetic dictation fixture — no microphone</h1>
      {bot && !callTarget && <Composer bot={bot} />}
    </div>
    {bot && surface === "bot-call" && <CallOverlay bot={bot} />}
    {bot && room && surface === "group-call" && <GroupCallOverlay group={room} members={[bot]} />}
  </main>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<StoreProvider><DesktopCapabilitiesProvider><Fixture /></DesktopCapabilitiesProvider></StoreProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
