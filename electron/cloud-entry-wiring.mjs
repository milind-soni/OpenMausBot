// Wires the cloud entry outside main.mjs, so the entry file stays a readable size.
import { createCloudEntry } from "./cloud-entry.mjs";

/** The desktop app's cloud entry: reveal its window, or open the cloud page once the workspace menu can act. */
export function createCloudEntryForApp({ activateExistingWindow, appWindows, tray, workspaceMenuAction, openCloudEntry }) {
  return createCloudEntry({
    reveal: () => { if (!tray()?.show()) activateExistingWindow(appWindows()); },
    open: async () => {
      let delivered = false;
      await workspaceMenuAction(async () => { delivered = await openCloudEntry(); });
      return delivered;
    },
  });
}
