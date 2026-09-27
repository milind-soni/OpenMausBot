import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { readEnvironment, readSessionState, signInPath, takeLoginTokenFromLocation, takePairingCodeFromLocation, takeInvitedEmailFromLocation } from "./lib/session";
import { bootstrapBrand } from "./lib/brand";
import { applySkin, readSkin } from "./lib/skins";
import { LoginPage } from "./pair/LoginPage";
import { PairPage } from "./pair/PairPage";
import { startAdMeasurement } from "./lib/ad-measurement";
import "./styles.css";

// Before the first paint, not inside a component: stamping the skin during
// render would show one frame of the default palette first. The brand (window
// title, accent) is fetched the same way so a white-labelled deployment never
// flashes the default name; it waits at most a moment and falls back silently.
applySkin(readSkin());

/** An emailed sign-in link lands on `#login=…`, a pairing link on /pair. A
 * remote browser without a session sees the email sign-in page when the
 * server offers it (anyone may sign up), and the pair page otherwise,
 * because every API call would fail with "pair this device"; on the owner's
 * own machine the server trusts loopback and this check is a single fast
 * request. */
async function chooseRoot(): Promise<React.ReactNode> {
  const loginToken = takeLoginTokenFromLocation();
  startAdMeasurement();
  if (loginToken) return <LoginPage initialToken={loginToken} />;
  if (location.pathname.replace(/\/+$/, "") === signInPath().replace(/\/+$/, "")) return <LoginPage />;
  const pairPath = `${import.meta.env.BASE_URL}pair`.replace(/\/\//g, "/");
  if (location.pathname === pairPath) return <PairPage initialCode={takePairingCodeFromLocation()} initialEmail={takeInvitedEmailFromLocation()} />;
  const session = await readSessionState();
  if (session.kind === "unauthenticated") {
    const environment = await readEnvironment();
    if (environment?.capabilities.accountSignIn) return <LoginPage reason={session.error} />;
    return <PairPage initialCode={null} reason={session.error} />;
  }
  // First-time visitors only need the sign-in page. Load the workspace and
  // its editors, renderers and integrations after the session check.
  const { default: App } = await import("./App");
  return <App />;
}

// A sign-in link opened in a tab that already shows the app (or the sign-in
// page) changes only the fragment, which reloads nothing: start again so the
// link is read like any other.
window.addEventListener("hashchange", () => {
  if (/[#&]login=/.test(location.hash)) location.reload();
});

void Promise.all([bootstrapBrand(), chooseRoot()]).then(([, root]) => {
  createRoot(document.getElementById("root")!).render(<StrictMode>{root}</StrictMode>);
});
