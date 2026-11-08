import { createRoot } from "react-dom/client";
import { LoginsSettings } from "../../src/components/LoginsSettings";
import { StoreProvider } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import "../../src/styles.css";

setAnalyticsEnabled(false);
createRoot(document.getElementById("root")!).render(
  <StoreProvider><main className="mx-auto max-w-3xl p-8"><LoginsSettings /></main></StoreProvider>,
);
