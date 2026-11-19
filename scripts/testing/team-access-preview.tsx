// The whole app as one person of a Team Cloud sees it: scripts/verify-team-bot-access.ts sends every request as them.
// ?skin= picks the skin.
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { GROK_MOVE_NOTICE, MODELGO_OFFER_NOTICE, TEAMS_NOTICE } from "../../src/lib/notices";
import { applySkinChoice, SKIN_IDS, type SkinId } from "../../src/lib/skins";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const skin = params.get("skin") ?? "daylight";
setAnalyticsEnabled(false);
setEmailGateDone("skipped");
localStorage.setItem(GROK_MOVE_NOTICE, "1");
localStorage.setItem(TEAMS_NOTICE, "1");
localStorage.setItem(MODELGO_OFFER_NOTICE, "1");
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "daylight");
createRoot(document.getElementById("root")!).render(<App />);
