import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BotSettingsDialog } from "../components/BotSettingsDialog";
import { StoreProvider, api, useStore, type Bot } from "../state/store";
import { applySkin } from "../lib/skins";
import "../styles.css";

let slowReads = false;
let readDelayMs = 1500;

function Fixture() {
  const { state, dispatch, flushBotPatches } = useStore();
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId) ?? state.bots[0];
  const [saved, setSaved] = useState<Bot[]>([]);
  const [delayReads, setDelayReads] = useState(false);
  const toggleDelay = () => { slowReads = !slowReads; setDelayReads(slowReads); };
  useEffect(() => {
    // Delay reads after taking their snapshot to reproduce stale responses.
    const realFetch = window.fetch;
    const delayedFetch: typeof window.fetch = async (input, init) => {
      const response = await realFetch.call(window, input, init);
      const url = input instanceof Request ? input.url : String(input);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (slowReads && /\/(history|overview|soul)(?:\?|$)/.test(url) && method === "GET") {
        await new Promise((resolve) => setTimeout(resolve, readDelayMs));
      }
      return response;
    };
    window.fetch = delayedFetch;
    return () => {
      if (window.fetch === delayedFetch) window.fetch = realFetch;
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.code === "KeyD") {
        event.preventDefault();
        slowReads = !slowReads;
        setDelayReads(slowReads);
        return;
      }
      if (!event.altKey || !/^[1-9]$/.test(event.key)) return;
      const target = state.bots[Number(event.key) - 1];
      if (target) { event.preventDefault(); dispatch({ type: "select", id: target.id }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, dispatch]);
  const readSaved = async () => {
    if (bot) await flushBotPatches(bot.id);
    const result = await api("/api/bots") as { bots: Bot[] };
    setSaved(result.bots);
  };
  return <main className="min-h-screen bg-panel p-8 text-ink">
    <h1 className="text-xl font-semibold">Isolated bot settings verification</h1>
    <p className="my-3">Alt+1–9 switches bots; Alt+D toggles delayed reads, including while settings is open. All data is disposable.</p>
    <label><input type="checkbox" checked={delayReads} onChange={toggleDelay} /> Delay profile reads</label>
    <label className="ml-3">Read delay (ms) <input type="number" defaultValue={1500} min={0} className="w-24 bg-control" onChange={(event) => { readDelayMs = Number(event.target.value); }} /></label>
    <div className="my-4 flex flex-wrap gap-3">
      {state.bots.map((candidate, index) => <button key={candidate.id} className="rounded bg-control px-3 py-2" onClick={() => dispatch({ type: "select", id: candidate.id })}>
        {index + 1}: {candidate.name}
      </button>)}
    </div>
    {bot && <div className="flex flex-wrap gap-3">
      <button className="rounded bg-control px-3 py-2" onClick={() => dispatch({ type: "toggleSettings", open: true })}>Open settings</button>
      <button className="rounded bg-control px-3 py-2" onClick={() => dispatch({ type: "duplicateBot", botId: bot.id })}>Duplicate selected bot</button>
      <button className="rounded bg-control px-3 py-2" onClick={() => void api(`/__fixture/drift/${bot.id}`, { method: "POST" })}>Edit SOUL file outside app</button>
      <button className="rounded bg-control px-3 py-2" onClick={() => void readSaved()}>Read saved profiles</button>
    </div>}
    <p className="my-3">Selected: {bot?.name ?? "Loading…"}</p>
    {state.error && <p role="alert" className="text-danger">{state.error}</p>}
    <pre aria-label="Saved profiles" className="my-4 whitespace-pre-wrap">{JSON.stringify(saved.map(({ id, name, description, soul }) => ({ id, name, description, soul })), null, 2)}</pre>
    {state.settingsOpen && bot && <BotSettingsDialog key={bot.id} bot={bot} />}
  </main>;
}

applySkin("midnight");
const root = createRoot(document.getElementById("root")!);
root.render(<StoreProvider><Fixture /></StoreProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
