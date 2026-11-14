import { createRoot } from "react-dom/client";
import { McpServersPanel } from "../../src/components/McpServersPanel";
import { StoreProvider } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

setAnalyticsEnabled(false);
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(
  <StoreProvider><main className="mx-auto max-w-4xl p-8"><McpServersPanel /></main></StoreProvider>,
);
