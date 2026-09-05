import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComputerPanel } from "../../src/components/ComputerPanel";
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
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const path = typeof input === "string" ? input : "";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  if (/^\/api\/bots\/[\w-]+\/computer$/.test(path)) return json({ configured: true, box: { state: "idle" } });
  if (path.endsWith("/computer/provision")) return json({ state: "idle" });
  if (path.endsWith("/computer/screenshot")) {
    const selectedMode = mode;
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
    return json({ png: selectedMode === "corrupt" ? "bm90IGFuIGltYWdl" : screenshot, format: "png" });
  }
  // Never allow the fixture's viewer/sleep actions to reach a real provider.
  if (path.endsWith("/computer/join") || path.endsWith("/computer/sleep")) {
    return json({ error: "This fixture tests previews only" }, 409);
  }
  return originalFetch(input, init);
};

function Fixture() {
  const { state, dispatch } = useStore();
  const bot = state.bots[0];
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (bot) {
      dispatch({ type: "screenFrame", botId: bot.id, png: blank, mime: "image/png" });
      dispatch({ type: "updateBot", botId: bot.id, patch: { computer: "cloud", cloudBackend: "box" } });
    }
  }, [bot?.id, dispatch]);
  return <div className="flex h-screen justify-center">
    <div className="fixed left-2 top-2 grid max-w-32 gap-3 text-sm">
      <label>Screenshot response<select aria-label="Screenshot response" defaultValue={mode} onChange={(e) => { mode = e.target.value; }}>
        {["connected", "slow", "failed", "corrupt", "timeout"].map((value) => <option key={value}>{value}</option>)}
      </select></label>
      <button onClick={() => setGeneration((n) => n + 1)}>Reconnect panel</button>
      <button onClick={() => setBusy(!busy)}>Busy: {String(busy)}</button>
      <button disabled={!bot} onClick={() => dispatch({ type: "screenFrame", botId: bot.id, png: frame("New live frame", "#312e81"), mime: "image/png" })}>Publish live frame</button>
    </div>
    {bot ? <ComputerPanel key={generation} bot={{ ...bot, busy }} /> : "Loading fixture…"}
  </div>;
}
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StoreProvider><Fixture /></StoreProvider>);
