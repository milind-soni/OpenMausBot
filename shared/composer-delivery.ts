/** Explicit composer intent. A steer is pinned to the opaque, server-issued running generation. */
export type ComposerDelivery = { mode: "queue" } | { mode: "steer"; runId: string };
