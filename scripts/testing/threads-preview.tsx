import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { ADVANCED_MODE_KEY, setAdvancedMode } from "../../src/lib/interface-mode";
import { BOAT_OFFER_NOTICE, GROK_MOVE_NOTICE, MODELGO_OFFER_NOTICE } from "../../src/lib/notices";
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
// Every launch is a new browser, so it opens in Simple mode as a new install does, unless a test chose a mode first.
// ?onboarding=1 plays a brand-new install.
if (localStorage.getItem(ADVANCED_MODE_KEY) == null) setAdvancedMode(false);
if (!new URLSearchParams(location.search).has("onboarding")) setEmailGateDone("skipped");
// Every launch is a new browser, so the once-per-browser Simple mode popup shows only with ?simpleModePrompt=1.
if (!new URLSearchParams(location.search).has("simpleModePrompt")) markSimpleModePromptSeen();
// The same for the once-per-person Move from Grok Bot popup, with ?grokMovePopup=1.
if (!new URLSearchParams(location.search).has("grokMovePopup")) localStorage.setItem(GROK_MOVE_NOTICE, "1");
// And for the once-per-person ModelGo sponsor card, with ?modelgoOffer=1: it sits over the sidebar's foot, where tests click.
if (!new URLSearchParams(location.search).has("modelgoOffer")) localStorage.setItem(MODELGO_OFFER_NOTICE, "1");
if (!new URLSearchParams(location.search).has("boatOffer")) localStorage.setItem(BOAT_OFFER_NOTICE, "1");
applySkinChoice(readSkinChoice());
createRoot(document.getElementById("root")!).render(<App />);
