import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComputerPanel } from "../../src/components/ComputerPanel";
import { BotSettingsDialog } from "../../src/components/BotSettingsDialog";
import { RemoteDesktopPanel } from "../../src/components/remote-desktop-panel";
import { StoreProvider, useStore } from "../../src/state/store";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

// Deliberately inject a valid but blank cached SSE image before connecting.
// The pre-fix panel keeps showing this even after successful screenshot polls.
const blank = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function frame(label: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 640, 400);
  context.fillStyle = "white";
  context.font = "28px sans-serif";
  context.fillText(label, 70, 210);
  return canvas.toDataURL("image/png").split(",")[1];
}
const screenshot = frame("Cloud screen connected", "#134e4a");
let mode = "connected";
// A host capture outlives an aborted renderer fetch. Keep this work pending
// until explicitly released, so reconnects exercise real lifecycle contention.
const transport = {
  requests: 0, aborted: 0, conflicts: 0, capturing: false,
  joining: false, duringJoin: 0, controlCalls: 0,
  releaseCapture: () => {}, releaseJoin: () => {},
  screenshot: `data:image/png;base64,${screenshot}`,
};
Object.assign(window, { cloudPreviewFixture: transport });
const viewerListeners = new Set<(state: { open: boolean; contextId: string }) => void>();
Object.assign(window, { ogb: { desktopViewer: {
  currentState: async () => ({ open: false, contextId: "" }),
  onState: (listener: (state: { open: boolean; contextId: string }) => void) => {
    viewerListeners.add(listener);
    return () => viewerListeners.delete(listener);
  },
  open: async (_url: string, _title: string, contextId: string) => {
    for (const listener of viewerListeners) listener({ open: true, contextId });
    return true;
  },
} } });
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const path = typeof input === "string" ? input : "";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  if (/^\/api\/bots\/[\w-]+\/computer$/.test(path)) return json({ configured: true, box: { state: "idle" } });
  if (path.endsWith("/computer/provision")) return json({ state: "idle" });
  if (path.endsWith("/computer/screenshot")) {
    transport.requests++;
    if (transport.joining) transport.duringJoin++;
    const selectedMode = mode;
    if (transport.capturing || selectedMode === "contended") {
      transport.conflicts++;
      return json({ error: "this bot's cloud computer is being changed — wait for it to finish" }, 409);
    }
    if (selectedMode === "held") {
      transport.capturing = true;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { transport.aborted++; reject(init?.signal?.reason); };
        transport.releaseCapture = () => {
          transport.capturing = false;
          init?.signal?.removeEventListener("abort", abort);
          resolve();
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
      return json({ png: frame("Released old capture", "#881337"), format: "png" });
    }
    if (selectedMode === "slow" || selectedMode === "timeout") {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(init?.signal?.reason); };
        const timer = setTimeout(() => {
          init?.signal?.removeEventListener("abort", abort);
          resolve();
        }, selectedMode === "slow" ? 12_000 : 120_000);
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (selectedMode === "failed") return json({ error: "The computer is temporarily unavailable" }, 503);
    if (selectedMode === "unconfigured") return json({ error: "VPS is not configured" }, 409);
    return json({ png: selectedMode === "corrupt" ? "bm90IGFuIGltYWdl" : screenshot, format: "png" });
  }
  if (path.endsWith("/computer/control") && init?.method === "POST") {
    transport.controlCalls++;
    return json({ held: JSON.parse(String(init.body)).action === "take", helpReason: null });
  }
  if (path.endsWith("/computer/join")) {
    transport.joining = true;
    await new Promise<void>((resolve) => {
      transport.releaseJoin = () => { transport.joining = false; resolve(); };
    });
    return json({ joinUrl: "/vps-viewer/fixture/" });
  }
  // Never allow the fixture's lifecycle actions to reach a real provider.
  if (path.endsWith("/computer/sleep")) {
    return json({ error: "This fixture tests previews only" }, 409);
  }
  return originalFetch(input, init);
};

function Fixture() {
  const { state, dispatch } = useStore();
  const bot = state.bots[0];
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [panel, setPanel] = useState("computer");
  useEffect(() => {
    if (bot) {
      dispatch({ type: "screenFrame", botId: bot.id, png: blank, mime: "image/png" });
      dispatch({ type: "updateBot", botId: bot.id, patch: { computer: "cloud", cloudBackend: "box" } });
      dispatch({ type: "toggleComputer", open: true });
    }
  }, [bot?.id, dispatch]);
  return <div className="flex h-screen justify-center">
    <div className="fixed left-2 top-2 grid max-w-32 gap-3 text-sm">
      <label>Screenshot response<select aria-label="Screenshot response" defaultValue={mode} onChange={(e) => { mode = e.target.value; }}>
        {["connected", "slow", "held", "contended", "failed", "unconfigured", "corrupt", "timeout"].map((value) => <option key={value}>{value}</option>)}
      </select></label>
      <label>Panel<select aria-label="Panel" value={panel} onChange={(event) => setPanel(event.target.value)}>
        <option value="computer">Computer</option><option value="remote">Remote desktop</option>
      </select></label>
      <button onClick={() => setGeneration((n) => n + 1)}>Reconnect panel</button>
      <button onClick={() => setBusy(!busy)}>Busy: {String(busy)}</button>
      <button onClick={() => transport.releaseCapture()}>Release held capture</button>
      <button onClick={() => transport.releaseJoin()}>Release desktop join</button>
      <button disabled={!bot} onClick={() => dispatch({ type: "screenFrame", botId: bot.id, png: frame("New live frame", "#312e81"), mime: "image/png" })}>Publish live frame</button>
    </div>
    {state.settingsOpen && bot && <BotSettingsDialog key={bot.id} bot={bot} />}
    {state.computerOpen && bot ? panel === "computer"
      ? <ComputerPanel key={generation} bot={{ ...bot, busy }} />
      : <RemoteDesktopPanel key={generation} bot={{ ...bot, busy }} />
      : !state.settingsOpen && <button onClick={() => dispatch({ type: "toggleComputer", open: true })}>Open computer panel</button>}
  </div>;
}
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StoreProvider><Fixture /></StoreProvider>);
