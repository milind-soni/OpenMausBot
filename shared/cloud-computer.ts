// Which engines can work on a cloud computer: Hosted desktop on Boat, or a
// self-hosted VPS. One rule for the server (every attach, readiness check and
// select_computer offer) and the renderer (the Works on panel, the composer's
// place chip, Webhooks and Routines), so the two never disagree.

/** The engine fact the rule reads. The server's provider instance and the
 * renderer's InstanceInfo both carry it. */
export interface CloudEngine {
  /** The engine mounts computer tools (`capabilities.computerMcp`). */
  computerMcp?: boolean;
}

/** An engine with computer tools gets the cloud computer as one more stdio
 * computer server, on a Boat and on a VPS alike. The turn always stays on the
 * bot's own engine; nothing hands it to another one. */
export function canWorkOnCloud(engine: CloudEngine | undefined): boolean {
  return engine?.computerMcp === true;
}
