import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { readEnvironment, readSessionState, signInPath, takeLoginTokenFromLocation, takePairingCodeFromLocation, takeInvitedEmailFromLocation } from "./lib/session";
import { bootstrapBrand } from "./lib/brand";
import { applySkin, readSkin } from "./lib/skins";
import { LoginPage } from "./pair/LoginPage";
import { PairPage } from "./pair/PairPage";
import { LoadFailed, ServerUnavailable } from "./pair/ServerUnavailable";
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
  // A browser that cannot reach the server cannot tell a visitor from a
  // member, so it says so and keeps trying instead of opening an empty
  // workspace. The desktop app shows the workspace while its own server starts.
  if (session.kind === "unreachable" && !window.ogb) return <ServerUnavailable />;
  if (session.kind === "unauthenticated") {
    // Ask twice: one lost answer would otherwise send a new visitor to the access-code page.
    let environment = await readEnvironment();
    if (!environment) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      environment = await readEnvironment();
    }
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

// A deploy replaces the build's files, so a page loaded just before one asks
// for code that no longer exists. Loading the page again picks up the new
// build; at most once a minute, so a real outage shows a message instead of
// reloading forever.
const RELOADED_FOR_BUILD = "nation-reloaded-for-build";
let reloading = false;
function reloadForNewBuild(): boolean {
  if (reloading) return true;
  // Offline, the missing code is the connection's fault; a reload would only
  // trade the page for the browser's own error.
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOADED_FOR_BUILD)) < 60_000) return false;
    sessionStorage.setItem(RELOADED_FOR_BUILD, String(Date.now()));
  } catch {
    return false; // without storage there is no way to stop after one reload
  }
  reloading = true;
  location.reload();
  return true;
}
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForNewBuild()) event.preventDefault();
});

void Promise.all([bootstrapBrand(), chooseRoot()]).then(
  ([, root]) => root,
  (error: unknown) => {
    if (reloadForNewBuild()) return null;
    console.error("The page could not start", error);
    return <LoadFailed />;
  },
).then((root) => {
  if (root) createRoot(document.getElementById("root")!).render(<StrictMode>{root}</StrictMode>);
});
