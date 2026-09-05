export const OPENMAUS_REGISTERED_APP_NAME = "OpenMausBot";

/** Return the Windows-owned UI where a person can choose the Grok Bot link handler. */
export function grokBotDefaultAppsSettingsUrl(platform = process.platform) {
  if (platform !== "win32") return null;
  return `ms-settings:defaultapps?registeredAppUser=${OPENMAUS_REGISTERED_APP_NAME}`;
}
