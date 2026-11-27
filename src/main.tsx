import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  previewBrowserSignIn, readSessionState, rememberTeamSignIn, takeBrowserSignInFromLocation, takePairingCodeFromLocation, takeInvitedEmailFromLocation,
} from "./lib/session";
import { bootstrapBrand, productName } from "./lib/brand";
import { t } from "./lib/i18n";
import { loadPageLanguage } from "./lib/language-preference";
import { applySkinChoice, readSkinChoice } from "./lib/skins";
import { applyChatWidth, readChatWidth } from "./lib/chat-width";
import { applyFont, readFont } from "./lib/fonts";
import { applySoftwareRendering } from "./lib/software-rendering";
import { loadTheme, startTheme } from "./lib/theme/runtime";
import { settleInterfaceMode } from "./lib/new-look";
import { BrowserSignInPage } from "./pair/BrowserSignInPage";
import { PairPage, TeamLeftPage } from "./pair/PairPage";
import { TEAM_LEFT_REFUSAL } from "../shared/cloud-hints";
import { HomeScreen, SignedOutAtHome } from "./components/HomeScreen";
import { PageBoundary } from "./components/PageBoundary";
import { endedBeforeReload, forgetEndedSession } from "./lib/session-ended";
import { signInGateShown } from "./lib/sign-in-gate";
import { startDesktopLaunchMarks } from "./lib/launch-marks";
import { serverFetch } from "./lib/relay-server";
import "./styles.css";

// Before first paint; settleInterfaceMode must run before applySkin writes omb-skin.
settleInterfaceMode();
applySkinChoice(readSkinChoice());
applyFont(readFont());
applySoftwareRendering();
applyChatWidth(readChatWidth());
startTheme();
const pageLanguage = loadPageLanguage();

// The app is its own chunk, so these pages don't parse it. Everywhere else its fetch starts now, alongside the session
// read, instead of after it. A failed fetch renders as a throw, so PageBoundary offers a reload.
const PAGES_WITHOUT_THE_APP = new Set(["/home", "/pair", "/desktop-viewer", "/local-app"]);
const loadApp = () => import("./App").catch((error: unknown) => ({ default: (): never => { throw error; } }));
const appPage = PAGES_WITHOUT_THE_APP.has(location.pathname) ? null : loadApp();
if (appPage) startDesktopLaunchMarks();

/** A team's name as its server describes itself to anyone (the descriptor's label), null when it can't say. */
const teamName = () => serverFetch("/.well-known/openmausbot/environment").then((res) => res.json() as Promise<{ label?: unknown; capabilities?: { cloudTeam?: unknown } }>)
  .then((descriptor) => (descriptor.capabilities?.cloudTeam === true && typeof descriptor.label === "string" ? descriptor.label : null), () => null);

async function chooseRoot(): Promise<React.ReactNode> {
  const home = window.ogb?.home;
  if (location.pathname === "/home" && home) return <HomeScreen bridge={home} manage={window.ogb?.cloudPlan?.manage} />;
  if (location.pathname === "/pair") {
    const signIn = takeBrowserSignInFromLocation();
    if (signIn) {
      const preview = await previewBrowserSignIn(signIn);
      await pageLanguage;
      return preview ? <BrowserSignInPage credential={signIn} owner={preview.owner} team={preview.team} /> : <PairPage initialCode={null} reason={t("pair.browser.signInFailed")} />;
    }
    return <PairPage initialCode={takePairingCodeFromLocation()} initialEmail={takeInvitedEmailFromLocation()} />;
  }
  const session = await readSessionState();
  if (session.kind === "unauthenticated") {
    await pageLanguage;
    if (session.error === TEAM_LEFT_REFUSAL) {
      signInGateShown("team_left");
      return <TeamLeftPage team={await teamName()} />;
    }
    signInGateShown(endedBeforeReload() ? "session_ended" : "signed_out");
    const pair = <PairPage initialCode={null} reason={endedBeforeReload() ? t("pair.sessionEnded") : session.error} />;
    return home ? <SignedOutAtHome bridge={home} fallback={pair} /> : pair;
  }
  forgetEndedSession();
  if (session.kind === "session") rememberTeamSignIn(session.teamSignIn);
  if (session.kind === "loopback" && session.trust === "service") {
    signInGateShown("service_trust");
    await pageLanguage;
    return <PairPage initialCode={null} reason={t("pair.serviceTrust")} />;
  }
  if (location.pathname === "/desktop-viewer") {
    const { DesktopViewer } = await import("./components/DesktopViewer");
    return <DesktopViewer />;
  }
  if (location.pathname === "/local-app") {
    const { LocalAppWindow } = await import("./local-app-window");
    await pageLanguage;
    return <LocalAppWindow id={new URLSearchParams(location.search).get("id") ?? ""} />;
  }
  const { default: App } = await (appPage ?? loadApp());
  void loadTheme();
  return <App />;
}

// The window is named before the brand file is asked for: the answer only ever renames it.
document.title = productName();
void Promise.all([bootstrapBrand(), chooseRoot(), pageLanguage]).then(([, root]) => {
  createRoot(document.getElementById("root")!).render(<StrictMode><PageBoundary>{root}</PageBoundary></StrictMode>);
});
