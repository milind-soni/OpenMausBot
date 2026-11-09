import { createRoot } from "react-dom/client";
import { UsageMenuRows } from "../../src/components/EngineUsage";
import "../../src/styles.css";

const root = createRoot(document.getElementById("root")!);
root.render(<main className="mx-auto max-w-lg p-4"><p>Isolated usage fixture</p><UsageMenuRows engine="codexWork" /></main>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
