// What a person reads when the secure connection service refuses or fails: one line per control-plane code.
import { ControlPlaneError } from "./control-plane-client.mjs";

export const FRIENDLY_MESSAGES = Object.freeze({
  invalid_email: "Enter a valid email address.",
  invalid_request: "The secure connection request was not accepted. Check the details and try again.",
  invalid_otp: "That code is not valid. Check the email and try again.",
  otp_expired: "That code expired. Email yourself a new one.",
  unauthorized: "Your sign-in expired. Email yourself a new code to reconnect.",
  forbidden: "The secure connection request was not allowed. Try signing in again.",
  signed_out: "Your sign-in expired. Email yourself a new code to reconnect.",
  network_unavailable: "OpenMausBot could not reach its secure connection service. Check your internet and try again.",
  rate_limited: "Too many attempts were made. Wait a little, then try again.",
  credential_rotation_rate_limited: "This computer was reconnected too often. Wait a little, then try again.",
  installation_limit_reached: "This account has reached its computer limit. Remove an old computer and try again.",
  installation_exists: "This computer is already connected. Try again to recover it.",
  endpoint_busy: "The secure connection is still being prepared. Try again in a moment.",
  endpoint_rate_limited: "The secure connection service is busy right now. Local Wi-Fi and Tailscale pairing still work; try again in {wait}.",
  update_required: "This version of MausBot can no longer make secure links. Update MausBot, then try again. Local Wi-Fi and Tailscale pairing still work.",
  endpoint_capacity: "Secure HTTPS links are temporarily full. Try again in {wait}, or pair on this Wi-Fi or with Tailscale.",
  endpoint_unavailable: "The secure connection service could not finish setup. Local Wi-Fi and Tailscale pairing still work. If this keeps happening, contact support with the error reference.",
  endpoint_cleanup_pending: "The secure connection is still being removed. Try signing out again shortly.",
  control_plane_unavailable: "Secure access is not available right now. Local pairing still works.",
  internal_error: "The secure connection service had a problem. Local pairing still works; try again.",
  invalid_response: "The secure connection service returned an unexpected response. Try again.",
  request_failed: "The secure connection request could not be completed. Local pairing still works; try again.",
});

function retryWait(retryAfterMs) {
  const seconds = Math.ceil((retryAfterMs ?? 0) / 1_000);
  if (!(seconds > 0)) return "a few minutes";
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

export function friendlyCompanionAccountError(error) {
  const code = error instanceof ControlPlaneError ? error.code : "";
  const message = (FRIENDLY_MESSAGES[code] ?? FRIENDLY_MESSAGES.request_failed)
    .replace("{wait}", () => retryWait(error.retryAfterMs));
  const reference = error instanceof ControlPlaneError && error.requestId
    ? ` Reference: ${error.requestId}.`
    : "";
  return `${message}${reference}`;
}
