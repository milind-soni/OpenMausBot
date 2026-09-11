// Fixture-only probe of the real renderer store. The app's active-turn UI
// shows presence rather than partial text; these outputs make both stream
// channels observable without changing that product behavior.
import { createRoot } from "react-dom/client";
import { StoreProvider, useStore, useStreaming } from "../../src/state/store";

function Probe() {
  const { state } = useStore();
  const stream = useStreaming();
  const bot = state.bots[0];
  return <>
    <output id="ready">{String(state.connected && !!bot)}</output>
    <output id="text">{bot && stream.streaming[bot.threadId]}</output>
    <output id="reasoning">{bot && stream.reasoning[bot.threadId]}</output>
    <output id="messages">{JSON.stringify(bot?.messages.filter((message) => message.role === "bot").map((message) => message.text) ?? [])}</output>
  </>;
}

createRoot(document.getElementById("root")!).render(<StoreProvider><Probe /></StoreProvider>);
