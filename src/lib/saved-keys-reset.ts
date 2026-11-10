/** Whether this app's desktop shell could not read its saved keys this launch. False on a page without that shell, on a
 * desktop that is a client of another computer (the notice there is about that computer's keys), or on any error. */
export async function savedKeysUnreadable(bridge: Window["ogb"] = window.ogb): Promise<boolean> {
  if (!bridge?.credentialStore || bridge.remoteClient?.active === true) return false;
  try {
    return (await bridge.credentialStore.unreadable()) === true;
  } catch {
    return false;
  }
}
