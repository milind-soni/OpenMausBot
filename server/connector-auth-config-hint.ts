// Composio answers "Composio does not manage auth for toolkit <slug> and no auth config without required fields is
// available. Please create an auth config manually or specify one in auth_config_override." when a toolkit has no
// Composio-managed sign-in and the Session names none of the project's own auth configs for it.
import { withFailedCallHint } from "./connector-scope-hint.ts";

const NO_MANAGED_AUTH = /does not manage auth for toolkit\s+([A-Za-z0-9_-]+)/i;

export type ConnectorBackend = "managed" | "self-hosted";

export function noManagedAuthToolkit(text: string): string | null {
  return NO_MANAGED_AUTH.exec(text)?.[1]?.toLowerCase() ?? null;
}

export function authConfigHint(backend: ConnectorBackend, toolkit: string): string {
  if (backend === "managed") {
    return `OpenMausBot note: ${toolkit} has no Composio-managed sign-in, so it needs the person's own OAuth app, which `
      + "OpenMausBot's built-in connected apps cannot use. Tell the person: add their own Composio project key in "
      + `Settings → API keys, with an enabled ${toolkit} auth config in that project, then connect ${toolkit}. Do not retry this call.`;
  }
  return `OpenMausBot note: ${toolkit} has no Composio-managed sign-in, so it needs an auth config with the person's own `
    + "OAuth app in their Composio project, enabled and enabled for Tool Router; OpenMausBot then uses it on its own. "
    + `If they have one, call COMPOSIO_MANAGE_CONNECTIONS with toolkits ["${toolkit}"] to connect it; to pick one config, `
    + `use toolkits [{"name":"${toolkit}","action":"add","auth_config_id":"ac_…"}]. If they have none, tell them to `
    + "create one (Auth Configs → Create in their Composio project). Do not retry this call.";
}

/** Adds the plain note to a tool result that failed with Composio's no-managed-auth error, naming its toolkit. */
export function withAuthConfigHint(
  bytes: Uint8Array,
  contentType: string,
  backend: ConnectorBackend,
): { bytes: Uint8Array; toolkit: string | null } {
  const toolkit = noManagedAuthToolkit(new TextDecoder().decode(bytes));
  if (!toolkit) return { bytes, toolkit: null };
  const hinted = withFailedCallHint(bytes, contentType, NO_MANAGED_AUTH, () => authConfigHint(backend, toolkit), []);
  return { bytes: hinted, toolkit: hinted === bytes ? null : toolkit };
}
