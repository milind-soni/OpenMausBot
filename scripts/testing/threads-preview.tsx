import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

// This entry point is served only by the disposable verification launcher.
setAnalyticsEnabled(false);
setEmailGateDone("skipped");
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<App />);
