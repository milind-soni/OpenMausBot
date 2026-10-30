import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {
  previewBrowserSignIn, readSessionState, takeBrowserSignInFromLocation, takePairingCodeFromLocation, takeInvitedEmailFromLocation,
} from "./lib/session";
import { bootstrapBrand } from "./lib/brand";
import { setLocale, t } from "./lib/i18n";
import { startupLocaleTag } from "./lib/language-preference";
import { applySkinChoice, readSkinChoice } from "./lib/skins";
import { applyChatWidth, readChatWidth } from "./lib/chat-width";
import { applyFont, readFont } from "./lib/fonts";
import { settleAdvancedModeDefault } from "./lib/interface-mode";
import { BrowserSignInPage } from "./pair/BrowserSignInPage";
import { PairPage } from "./pair/PairPage";
import { HomeScreen, SignedOutAtHome } from "./components/HomeScreen";
import { endedBeforeReload, forgetEndedSession, SESSION_ENDED_REASON } from "./lib/session-ended";
import "./styles.css";

// Before first paint; settleAdvancedModeDefault must run before applySkin writes omb-skin.
settleAdvancedModeDefault();
applySkinChoice(readSkinChoice());
applyFont(readFont());
applyChatWidth(readChatWidth());
setLocale(startupLocaleTag());

async function chooseRoot(): Promise<React.ReactNode> {
  const home = window.ogb?.home;
  if (location.pathname === "/home" && home) return <HomeScreen bridge={home} manage={window.ogb?.cloudPlan?.manage} />;
  // The window's own rail of places (electron/chrome-rail.mjs): see-through but for the rail and its open sheets.
  if (location.pathname === "/rail" && window.ogb?.rail?.expand) {
    document.documentElement.style.background = document.body.style.background = "transparent";
    const { ChromeRail } = await import("./components/ChromeRail");
    return <ChromeRail />;
  }
  if (location.pathname === "/pair") {
    const signIn = takeBrowserSignInFromLocation();
    if (signIn) {
      const preview = await previewBrowserSignIn(signIn);
      return preview ? <BrowserSignInPage credential={signIn} owner={preview.owner} /> : <PairPage initialCode={null} reason={t("pair.browser.signInFailed")} />;
    }
    return <PairPage initialCode={takePairingCodeFromLocation()} initialEmail={takeInvitedEmailFromLocation()} />;
  }
  const session = await readSessionState();
  if (session.kind === "unauthenticated") {
    const pair = <PairPage initialCode={null} reason={endedBeforeReload() ? SESSION_ENDED_REASON : session.error} />;
    return home ? <SignedOutAtHome bridge={home} fallback={pair} /> : pair;
  }
  forgetEndedSession();
  if (session.kind === "loopback" && session.trust === "service") return <PairPage initialCode={null} reason={t("pair.serviceTrust")} />;
  if (location.pathname === "/desktop-viewer") {
    const { DesktopViewer } = await import("./components/DesktopViewer");
    return <DesktopViewer />;
  }
  return <App />;
}

void Promise.all([bootstrapBrand(), chooseRoot()]).then(([, root]) => {
  createRoot(document.getElementById("root")!).render(<StrictMode>{root}</StrictMode>);
});
