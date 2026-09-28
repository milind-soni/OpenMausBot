import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmDialog } from "../../src/components/ConfirmDialog";
import "../../src/styles.css";

function Preview() {
  const [open, setOpen] = useState(false);
  return <main>
    <button onClick={() => setOpen(true)}>Open confirmation</button>
    <ConfirmDialog open={open} title="Focus regression" body="No explicit return focus reference."
      confirmLabel="Confirm" onCancel={() => setOpen(false)} onConfirm={() => setOpen(false)} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
