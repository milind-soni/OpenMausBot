import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  previewBrowserSignIn, readSessionState, takeBrowserSignInFromLocation, takePairingCodeFromLocation, takeInvitedEmailFromLocation,
} from "./lib/session";
import { bootstrapBrand, productName } from "./lib/brand";
import { t } from "./lib/i18n";
import { loadPageLanguage } from "./lib/language-preference";
import { applySkinChoice, readSkinChoice } from "./lib/skins";
import { applyChatWidth, readChatWidth } from "./lib/chat-width";
import { applyFont, readFont } from "./lib/fonts";
import { applySoftwareRendering } from "./lib/software-rendering";
import { settleAdvancedModeDefault } from "./lib/interface-mode";
import { BrowserSignInPage } from "./pair/BrowserSignInPage";
import { PairPage } from "./pair/PairPage";
import { HomeScreen, SignedOutAtHome } from "./components/HomeScreen";
import { PageBoundary } from "./components/PageBoundary";
import { endedBeforeReload, forgetEndedSession } from "./lib/session-ended";
import "./styles.css";

// Before first paint; settleAdvancedModeDefault must run before applySkin writes omb-skin.
settleAdvancedModeDefault();
applySkinChoice(readSkinChoice());
applyFont(readFont());
applySoftwareRendering();
applyChatWidth(readChatWidth());
const pageLanguage = loadPageLanguage();

// The app is its own chunk, so these pages don't parse it. Everywhere else its fetch starts now, alongside the session
// read, instead of after it. A failed fetch renders as a throw, so PageBoundary offers a reload.
const PAGES_WITHOUT_THE_APP = new Set(["/home", "/pair", "/desktop-viewer"]);
const loadApp = () => import("./App").catch((error: unknown) => ({ default: (): never => { throw error; } }));
const appPage = PAGES_WITHOUT_THE_APP.has(location.pathname) ? null : loadApp();

async function chooseRoot(): Promise<React.ReactNode> {
  const home = window.ogb?.home;
  if (location.pathname === "/home" && home) return <HomeScreen bridge={home} manage={window.ogb?.cloudPlan?.manage} />;
  if (location.pathname === "/pair") {
    const signIn = takeBrowserSignInFromLocation();
    if (signIn) {
      const preview = await previewBrowserSignIn(signIn);
      await pageLanguage;
      return preview ? <BrowserSignInPage credential={signIn} owner={preview.owner} /> : <PairPage initialCode={null} reason={t("pair.browser.signInFailed")} />;
    }
    return <PairPage initialCode={takePairingCodeFromLocation()} initialEmail={takeInvitedEmailFromLocation()} />;
  }
  const session = await readSessionState();
  if (session.kind === "unauthenticated") {
    await pageLanguage;
    const pair = <PairPage initialCode={null} reason={endedBeforeReload() ? t("pair.sessionEnded") : session.error} />;
    return home ? <SignedOutAtHome bridge={home} fallback={pair} /> : pair;
  }
  forgetEndedSession();
  if (session.kind === "loopback" && session.trust === "service") {
    await pageLanguage;
    return <PairPage initialCode={null} reason={t("pair.serviceTrust")} />;
  }
  if (location.pathname === "/desktop-viewer") {
    const { DesktopViewer } = await import("./components/DesktopViewer");
    return <DesktopViewer />;
  }
  const { default: App } = await (appPage ?? loadApp());
  return <App />;
}

// The window is named before the brand file is asked for: the answer only ever renames it.
document.title = productName();
void Promise.all([bootstrapBrand(), chooseRoot(), pageLanguage]).then(([, root]) => {
  createRoot(document.getElementById("root")!).render(<StrictMode><PageBoundary>{root}</PageBoundary></StrictMode>);
});
