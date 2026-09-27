// Optional, explicitly consented advertising measurement. No account identity,
// email, wallet, prompt or conversation data is passed to the advertising SDK.
// The public pixel ID is configured by the operator, never committed here.
const PIXEL_ID = String(import.meta.env.VITE_META_PIXEL_ID ?? "");
const CONSENT = "nation-ad-measurement-v1";
const PENDING = "nation-new-registration-v1";
const MAX_PENDING_AGE = 10 * 60_000;

type Pixel = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  loaded: boolean;
  version: string;
  push: Pixel;
  disablePushState: boolean;
};
type PixelWindow = Window & { fbq?: Pixel; _fbq?: Pixel };
let choice: boolean | undefined;
let loading = false;
let loaded = false;
let pageSent = false;

export function adMeasurementAvailable(): boolean {
  return /^\d{5,30}$/.test(PIXEL_ID) && typeof location !== "undefined"
    && location.protocol === "https:" && location.hostname === "thenation.city";
}

export function adMeasurementAllowed(): boolean {
  if (!adMeasurementAvailable()) return false;
  try {
    if (localStorage.getItem("omb-analytics-opt-out") === "1") return false;
    if ((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true) return false;
    return choice ?? localStorage.getItem(CONSENT) === "yes";
  } catch { return false; }
}

// Never let the SDK read sign-in fragments, emails or arbitrary URL parameters.
// Private workspace routes and browser previews are excluded entirely.
export function safeAdLocation(url: URL): boolean {
  if (url.hash || !/^\/swarm\/?$|^\/swarm\/sign-in\/?$/.test(url.pathname)) return false;
  return [...url.searchParams].every(([key, value]) =>
    /^(utm_source|utm_medium|utm_campaign|utm_content|utm_term|fbclid)$/.test(key)
    && value.length <= 1024 && /^[a-zA-Z0-9._~-]*$/.test(value));
}

function removePending() {
  try { localStorage.removeItem(PENDING); } catch { /* Measurement must never break sign-in. */ }
}

export function setAdMeasurementAllowed(allowed: boolean) {
  choice = allowed;
  try { localStorage.setItem(CONSENT, allowed ? "yes" : "no"); } catch { /* Session choice still holds. */ }
  if (!allowed) {
    removePending();
    if (typeof window !== "undefined") (window as PixelWindow).fbq?.("consent", "revoke");
    return;
  }
  startAdMeasurement();
}

/** Only the successful verify response may call this, before its redirect.
 * A returning login, an email request or a form click is never a registration. */
export function recordNewRegistration(created: boolean | undefined) {
  if (created !== true || !adMeasurementAllowed()) return;
  try {
    localStorage.setItem(PENDING, JSON.stringify({ id: crypto.randomUUID(), at: Date.now() }));
  } catch { /* Unavailable storage cannot prevent opening the workspace. */ }
}

function sendReadyEvents() {
  if (!loaded || !adMeasurementAllowed() || !safeAdLocation(new URL(location.href))) return;
  const pixel = (window as PixelWindow).fbq;
  if (!pixel) return;
  pixel("consent", "grant");
  if (!pageSent) {
    pageSent = true;
    pixel("trackSingle", PIXEL_ID, "PageView");
  }
  try {
    const raw = localStorage.getItem(PENDING);
    if (!raw) return;
    const pending: unknown = JSON.parse(raw);
    removePending(); // Consume before sending; repeat mounts must not repeat it.
    const id = Reflect.get(Object(pending), "id");
    const at = Reflect.get(Object(pending), "at");
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || typeof at !== "number"
      || Date.now() < at || Date.now() - at > MAX_PENDING_AGE) return;
    pixel("trackSingle", PIXEL_ID, "CompleteRegistration", {}, { eventID: id });
  } catch { removePending(); }
}

/** Fail closed: no SDK request before consent, on preview hosts, or on a URL
 * containing a token. SDK errors never block the site's own UI. */
export function startAdMeasurement() {
  if (!adMeasurementAllowed() || !safeAdLocation(new URL(location.href))) return;
  if (loaded) { sendReadyEvents(); return; }
  if (loading) return;
  // Do not attach our events to an unrelated integration installed elsewhere.
  const target = window as PixelWindow;
  if (target.fbq) return;
  loading = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== CONSENT && event.key !== "omb-analytics-opt-out" && event.key !== null) return;
    choice = undefined;
    if (!adMeasurementAllowed()) {
      removePending();
      target.fbq?.("consent", "revoke");
    }
  });
  const pixel = function (...args: unknown[]) {
    if (pixel.callMethod) pixel.callMethod(...args);
    else pixel.queue.push(args);
  } as Pixel;
  pixel.queue = [];
  pixel.loaded = true;
  pixel.version = "2.0";
  pixel.push = pixel;
  pixel.disablePushState = true;
  target.fbq = pixel;
  target._fbq = pixel;
  pixel("consent", "grant");
  pixel("set", "autoConfig", false, PIXEL_ID);
  pixel("init", PIXEL_ID); // No advanced-matching identifiers.
  const script = document.createElement("script");
  script.async = true;
  script.src = "https://connect.facebook.net/en_US/fbevents.js";
  script.onload = () => { loaded = true; sendReadyEvents(); };
  script.onerror = () => { /* Blockers and network failure do not affect signup. */ };
  document.head.appendChild(script);
}
