// A connected account whose sign-in expired or was revoked fails each call with an auth error the model reads as a dead
// end. Only failed results are read: a successful answer may quote these words.
import { annotateFailedCall } from "./connector-scope-hint.ts";
import { connectorCallFromFrame, serviceSlugFor, serviceSlugForCandidates } from "./connector-verdict.ts";

const SIGNED_OUT = /USER_NOT_LOGGED_IN|not logged in|no (?:active )?connected account|connected account (?:not found|is not active|is inactive|has expired)|invalid authentication credentials|\bunauthenticated\b|\b401\b|invalid_grant/i;

export function signedOutHint(services: readonly string[]): string {
  const apps = services.length ? services.join(", ") : "The app";
  const target = services.length ? `with toolkits ${JSON.stringify(services)}` : "for that app";
  return `OpenMausBot note: ${apps} is signed out (its sign-in expired or was revoked), so this call did not run. ` +
    `Call COMPOSIO_MANAGE_CONNECTIONS ${target} to show the person a card that reconnects it, then end this turn. ` +
    "Do not retry this call before they reconnect.";
}

/** Adds the reconnect note to `response` when the `request` it answers failed for want of a sign-in. */
export function withSignedOutHint(
  request: unknown,
  response: Record<string, unknown>,
  connectedServices: readonly string[],
): Record<string, unknown> {
  const call = connectorCallFromFrame(request);
  const services = (tools: readonly string[]) => [...new Set(tools.flatMap((tool) => {
    const service = tool.startsWith("COMPOSIO_") ? null : serviceSlugForCandidates(tool, connectedServices) ?? serviceSlugFor(tool);
    return service ? [service] : [];
  }))];
  annotateFailedCall(response, SIGNED_OUT, (failed) => signedOutHint(services(failed)), call.kind === "tools" ? call.names : []);
  return response;
}
