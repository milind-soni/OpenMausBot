// The email-code sign-in the phone apps use (openmaus-cloud server/cloud-app-signin.ts), typed into the app: it ends in
// the same omc_ device token as the browser approval. The attempt and the token stay in main; the page sees outcomes only.
export const SIGN_IN_START = "/api/cloud/app/sign-in/start";
export const SIGN_IN_VERIFY = "/api/cloud/app/sign-in/verify";
/** The Admin's code tries per email (Better Auth emailOTP `allowedAttempts`, server/auth.ts); the sixth answer is "expired". */
export const SIGN_IN_TRIES = 5;
const ATTEMPT = /^[A-Za-z0-9_-]{43}$/;
const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** An address the Admin's own check would take, lower-cased; anything else is no address. */
export function cleanEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && !CONTROL.test(email) && EMAIL.test(email) ? email : null;
}

/** Eight digits, as typed or pasted with spaces or a dash; anything else is no code. */
export function cleanCode(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const digits = value.replace(/[\s-]/g, "");
  return /^\d{8}$/.test(digits) ? digits : null;
}

/** What the Admin needs to name this computer; the app's own version, or a neutral one it accepts. */
export function signInIdentity({ deviceName, platform, appVersion }) {
  if (typeof deviceName !== "string" || !deviceName.trim() || deviceName.length > 100 || CONTROL.test(deviceName)) return null;
  if (!["darwin", "win32", "linux"].includes(platform)) return null;
  return { deviceName, platform, appVersion: typeof appVersion === "string" && APP_VERSION.test(appVersion) ? appVersion : "0.0.0" };
}

/** The start answer, or null: the attempt, how long it lasts, when a new code may be sent, and whether new accounts
 * are open (closed, a code reaches only an address that already has one: the Admin answers the same either way). */
export function parseSignInStart(result) {
  if (result?.cloudContractVersion !== 1 || !ATTEMPT.test(result.attempt ?? "")) return null;
  const expiresIn = Number.isSafeInteger(result.expiresIn) && result.expiresIn >= 60 && result.expiresIn <= 3600 ? result.expiresIn : null;
  const resendAfter = Number.isSafeInteger(result.resendAfter) && result.resendAfter >= 0 && result.resendAfter <= 600 ? result.resendAfter : 30;
  return expiresIn ? { attempt: result.attempt, expiresIn, resendAfter, signupOpen: result.signupOpen !== false } : null;
}

/** Only the Admin's own JSON answer names a reason; a page from in between is a failure to reach it. */
const said = (error, status, code) => !error?.opaque && error?.status === status && (code === undefined || error.code === code);
/** Where the email route does not exist (an older or single sign-on Admin), the browser approval is the way in. */
const noEmailRoute = error => [404, 405, 501].includes(error?.status) && (error.opaque || error.code === "unsupported" || error.code === "not_found" || error.code === undefined);

export function startFailure(error) {
  if (said(error, 403, "sso")) return "sso";
  if (said(error, 429)) return "rate-limited";
  if (noEmailRoute(error)) return "browser";
  if (said(error, 400, "invalid_request")) return "invalid-email";
  return "failed";
}

export function verifyFailure(error) {
  if (said(error, 400, "invalid_code")) return "wrong-code";
  if (said(error, 410)) return "expired";
  if (said(error, 403, "sso")) return "sso";
  if (said(error, 403, "two_factor")) return "two-factor";
  if (said(error, 403, "signup_closed")) return "signup-closed";
  if (said(error, 403, "device_limit")) return "device-limit";
  if (said(error, 429)) return "rate-limited";
  if (noEmailRoute(error)) return "browser";
  return "failed";
}
