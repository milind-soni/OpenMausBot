// macOS's own privacy permissions: asking for the microphone, and the System Settings pane for each permission.

const PANES = Object.freeze({
  mic: "Privacy_Microphone",
  screen: "Privacy_ScreenCapture",
  speech: "Privacy_SpeechRecognition",
  accessibility: "Privacy_Accessibility",
});

/** A permission's pane in System Settings → Privacy & Security, or the section itself for any other name: macOS never
 * asks again for a permission that was denied, so its pane is the only way to grant it. False where there is none. */
export function openPrivacySettings(pane, { available, openExternal }) {
  if (!available) return false;
  // Own-property lookup: "__proto__" or "constructor" must not resolve up the prototype chain.
  const anchor = Object.hasOwn(PANES, pane) ? PANES[pane] : "Privacy";
  return openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
}

/** macOS asks the person for the microphone; false where it can't be asked, or when they decline. */
export async function askForMicrophone({ available, systemPreferences }) {
  if (!available) return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
}
