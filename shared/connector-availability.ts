export type ConnectedAppsMode = "managed" | "self-hosted" | "unavailable";

const MANAGED_CUSTOM_AUTH_TOOLKITS = new Set(["twitter", "x"]);

/**
 * Some Composio toolkits no longer include provider-managed credentials.
 * The official OpenMausBot broker cannot offer those connections until its
 * project owns the corresponding OAuth app. Self-hosted Composio projects can
 * still supply their own auth config, so keep this restriction mode-specific.
 */
export function managedConnectorUnavailableReason(
  mode: ConnectedAppsMode,
  slug: string,
): string | null {
  if (mode !== "managed" || !MANAGED_CUSTOM_AUTH_TOOLKITS.has(slug.trim().toLowerCase())) return null;
  return "Twitter/X needs your own X Developer app and Composio auth config. Use self-hosted connected apps for now.";
}
