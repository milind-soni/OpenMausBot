// The sidebar attention popover geometry fixture: the real Sidebar through the
// shared StoreProvider, pinned to the density named in ?density= before the
// first render (Sidebar seeds its density state from localStorage once, at
// mount, and never re-reads it). Driven headlessly by
// scripts/testing/sidebar-attention-ui-smoke.cjs.
import { createRoot } from "react-dom/client";
import { saveSidebarDensity } from "../../src/lib/sidebar-preferences";
import { Sidebar } from "../../src/components/Sidebar";
import { StoreProvider } from "../../src/state/store";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

const density = new URLSearchParams(window.location.search).get("density");
if (density === "compact" || density === "comfortable" || density === "icons") {
  saveSidebarDensity(density);
}

function Fixture() {
  return <div className="flex h-screen">
    <Sidebar open onClose={() => {}} />
    <main className="p-8">
      <h1>Isolated sidebar attention verification</h1>
      <p>Nothing is selected; the attention popover opens from the header.</p>
    </main>
  </div>;
}
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StoreProvider><Fixture /></StoreProvider>);
