import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { setAdvancedMode } from "../../src/lib/interface-mode";
import { GROK_MOVE_NOTICE, MODELGO_OFFER_NOTICE } from "../../src/lib/notices";
import { markSimpleModePromptSeen } from "../../src/lib/simple-mode-prompt";
import { applySkin, type SkinId } from "../../src/lib/skins";
import "../../src/styles.css";

// Served only by scripts/verify-sidebar-groups.ts: the real app against its disposable fixture. ?mode=simple is Simple
// mode, ?skin= the skin.
const params = new URLSearchParams(location.search);
setAnalyticsEnabled(false);
setEmailGateDone("skipped");
markSimpleModePromptSeen();
localStorage.setItem(GROK_MOVE_NOTICE, "1");
localStorage.setItem(MODELGO_OFFER_NOTICE, "1");
setAdvancedMode(params.get("mode") !== "simple");
applySkin((params.get("skin") ?? "daylight") as SkinId);
createRoot(document.getElementById("root")!).render(<App />);
