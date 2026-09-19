import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComputerPanel } from "../../src/components/ComputerPanel";
import { BotSettingsDialog } from "../../src/components/BotSettingsDialog";
import { RemoteDesktopPanel } from "../../src/components/remote-desktop-panel";
import { StoreProvider, useStore, overlayOpen, type Bot } from "../../src/state/store";
import { applySkin, readSkin } from "../../src/lib/skins";
import { CLOUD_COMPUTER_BUSY_ERROR } from "../../shared/computer-contention";
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
const vmScreenshot = `data:image/png;base64,${frame("Local VM connected", "#1e3a8a")}`;
let mode = "connected";
let surfaceScenario = "default";
// A host capture outlives an aborted renderer fetch. Keep this work pending
// until explicitly released, so reconnects exercise real lifecycle contention.
const transport = {
  requests: 0, aborted: 0, conflicts: 0, capturing: false,
  joining: false, duringJoin: 0, controlCalls: 0, opened: 0, abortedJoins: 0,
  releaseCapture: () => {}, releaseJoin: () => {},
  screenshot: `data:image/png;base64,${screenshot}`,
  vmScreenshot, paths: [] as string[], vmRequests: 0, vmPending: false, releaseVm: () => {},
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
    transport.opened++;
    for (const listener of viewerListeners) listener({ open: true, contextId });
    return true;
  },
} } });
let turnActive = false;
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const requested = typeof input === "string" ? input : "";
  const path = requested.split("?")[0];
  if (path.includes("/computer") || path.includes("/local-computer")) transport.paths.push(requested);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  if (/^\/api\/bots\/[\w-]+\/computer$/.test(path)) return json({ surface: surfaceScenario === "auto-vm" ? "vm" : "cloud", configured: true, box: { state: "idle" } });
  if (path.endsWith("/local-computer")) return json({ mode: "per-bot", max_instances: 2, image: true, create_supported: true,
    container: "running", imageMatches: true, managed: true, network: "loopback", security: "hardened", persistence: "durable",
    desktopReady: true, ready: true, problem: null, viewer_url: "http://127.0.0.1/fixture-viewer" });
  if (path.endsWith("/local-computer/screenshot")) {
    transport.vmRequests++;
    if (mode === "held") {
      transport.vmPending = true;
      // Deliberately finish even after cancellation to prove an old frame
      // cannot replace the next conversation's preview.
      await new Promise<void>((resolve) => { transport.releaseVm = () => { transport.vmPending = false; resolve(); }; });
    }
    return json({ image: vmScreenshot });
  }
  // The real server refuses provision/sleep while a turn owns the box.
  if (path.endsWith("/computer/provision")) {
    if (turnActive) return json({ error: CLOUD_COMPUTER_BUSY_ERROR }, 409);
    return json({ state: "idle" });
  }
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
    await new Promise<void>((resolve, reject) => {
      const abort = () => { transport.joining = false; transport.abortedJoins++; reject(init?.signal?.reason); };
      transport.releaseJoin = () => { init?.signal?.removeEventListener("abort", abort); transport.joining = false; resolve(); };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
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
  const [scenario, setScenario] = useState("default");
  useEffect(() => {
    if (bot) {
      dispatch({ type: "screenFrame", botId: bot.id, png: blank, mime: "image/png" });
      dispatch({ type: "updateBot", botId: bot.id, patch: { computer: "cloud", cloudBackend: "box" } });
      dispatch({ type: "openOverlay", kind: "computer", open: true });
    }
  }, [bot?.id, dispatch]);
  useEffect(() => {
    if (state.config && state.config.features?.browser !== true) {
      dispatch({ type: "configStatus", config: { ...state.config, features: { ...state.config.features, browser: true },
        browserEngine: { kind: "unavailable", installable: true } } });
    }
  }, [state.config, dispatch]);
  useEffect(() => {
    const base = state.instances[0];
    if (base && !state.instances.some((instance) => instance.driverKind === "boxAgent")) {
      // Registry display only; every cloud operation remains the transport
      // stub above, never the paid Box service.
      dispatch({ type: "instances", instances: [...state.instances,
        { ...base, instanceId: "fixture-box", driverKind: "boxAgent" }] });
    }
  }, [state.instances, dispatch]);
  const fixtureBot: Bot | undefined = bot && (scenario === "default"
    ? { ...bot, busy, tasks: bot.tasks?.map((task) => ({ ...task, busy })) }
    : { ...bot, busy: false, browser: true,
      computer: scenario === "auto-vm" ? undefined : scenario === "cloud-pin" ? "local" : scenario === "off" ? "off" : "cloud",
      modelSelection: scenario === "vm-pin" ? { ...bot.modelSelection, instanceId: "unavailable-profile-engine" } : bot.modelSelection,
      threadId: `fixture-${scenario}`,
      tasks: [{ threadId: `fixture-${scenario}`, title: scenario, createdAt: 1, busy: false, modelSelection: bot.modelSelection,
        ...(scenario === "auto-vm" ? {} : { surface: scenario === "browser-pin" ? "browser" : scenario === "cloud-pin" ? "cloud" : "vm" }) }],
    });
  return <div className="flex h-screen justify-center">
    <div className="fixed left-2 top-2 grid max-w-32 gap-3 text-sm">
      <label>Screenshot response<select aria-label="Screenshot response" defaultValue={mode} onChange={(e) => { mode = e.target.value; }}>
        {["connected", "slow", "held", "contended", "failed", "unconfigured", "corrupt", "timeout"].map((value) => <option key={value}>{value}</option>)}
      </select></label>
      <label>Panel<select aria-label="Panel" value={panel} onChange={(event) => setPanel(event.target.value)}>
        <option value="computer">Computer</option><option value="remote">Remote desktop</option>
      </select></label>
      <label>Conversation<select aria-label="Conversation surface" value={scenario} onChange={(event) => {
        surfaceScenario = event.target.value; setScenario(surfaceScenario);
      }}>
        {["default", "vm-pin", "auto-vm", "cloud-pin", "browser-pin", "off"].map((value) => <option key={value}>{value}</option>)}
      </select></label>
      <button onClick={() => setGeneration((n) => n + 1)}>Reconnect panel</button>
      <button onClick={() => { turnActive = !busy; setBusy(!busy); }}>Busy: {String(busy)}</button>
      <button onClick={() => transport.releaseCapture()}>Release held capture</button>
      <button onClick={() => transport.releaseJoin()}>Release desktop join</button>
      <button onClick={() => transport.releaseVm()}>Release VM capture</button>
      <button disabled={!bot} onClick={() => dispatch({ type: "screenFrame", botId: bot.id, png: frame("New live frame", "#312e81"), mime: "image/png" })}>Publish live frame</button>
    </div>
    {overlayOpen(state, "settings") && bot && <BotSettingsDialog key={bot.id} bot={bot} />}
    {overlayOpen(state, "computer") && fixtureBot ? panel === "computer"
      ? <ComputerPanel key={generation} bot={fixtureBot} />
      : <RemoteDesktopPanel key={generation} bot={fixtureBot} />
      : !overlayOpen(state, "settings") && <button onClick={() => dispatch({ type: "openOverlay", kind: "computer", open: true })}>Open computer panel</button>}
  </div>;
}
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StoreProvider><Fixture /></StoreProvider>);
