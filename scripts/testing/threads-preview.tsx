import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

// This entry point is served only by the disposable verification launcher.
// The voice-latency harness opts in with ?ombVoiceProbe=1; the recorder in
// src/lib/voice-latency-probe stays inert without this sink.
if (new URLSearchParams(location.search).has("ombVoiceProbe")) {
  (window as typeof window & { __ombVoiceProbe?: unknown[] }).__ombVoiceProbe = [];
}
setAnalyticsEnabled(false);
if (!new URLSearchParams(location.search).has("onboarding")) setEmailGateDone("skipped");
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<App />);
