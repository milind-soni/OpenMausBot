// Which engines can work on a cloud computer (Boat, or a self-hosted VPS): one
// rule for the server and the renderer.

/** The engine fact the rule reads. The server's provider instance and the
 * renderer's InstanceInfo both carry it. */
export interface CloudEngine {
  computerMcp?: boolean;
}

/** An engine with computer tools gets the cloud computer as one more stdio
 * computer server, on a Boat and on a VPS alike. The turn always stays on the
 * bot's own engine; nothing hands it to another one. */
export function canWorkOnCloud(engine: CloudEngine | undefined): boolean {
  return engine?.computerMcp === true;
}
