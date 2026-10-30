import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { setAdvancedMode } from "../../src/lib/interface-mode";
import { markSimpleModePromptSeen } from "../../src/lib/simple-mode-prompt";
import { applySkinChoice, readSkinChoice } from "../../src/lib/skins";
import "../../src/styles.css";

// This entry point is served only by the disposable verification launcher.
// The voice-latency harness opts in with ?ombVoiceProbe=1; the recorder in
// src/lib/voice-latency-probe stays inert without this sink.
if (new URLSearchParams(location.search).has("ombVoiceProbe")) {
  (window as typeof window & { __ombVoiceProbe?: unknown[] }).__ombVoiceProbe = [];
}
setAnalyticsEnabled(false);
// ?onboarding=1 plays a brand-new install, and a new install opens in Simple mode.
if (new URLSearchParams(location.search).has("onboarding")) setAdvancedMode(false);
else setEmailGateDone("skipped");
// Every launch is a new browser, so the once-per-browser Simple mode popup shows only with ?simpleModePrompt=1.
if (!new URLSearchParams(location.search).has("simpleModePrompt")) markSimpleModePromptSeen();
applySkinChoice(readSkinChoice());
createRoot(document.getElementById("root")!).render(<App />);
