import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../src/components/Sidebar";
import { StoreProvider } from "../../src/state/store";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

function Fixture() {
  const [open, setOpen] = useState(true);
  return <div className="flex h-screen">
    <Sidebar open={open} onClose={() => setOpen(false)} />
    <main className="p-8">
      <h1>Isolated sidebar verification</h1>
      <p>Drawer: {open ? "open" : "closed"}</p>
      <button onClick={() => setOpen(true)}>Open sidebar</button>
    </main>
  </div>;
}
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StoreProvider><Fixture /></StoreProvider>);
