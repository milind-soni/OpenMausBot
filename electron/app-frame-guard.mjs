// A chat app runs in a srcdoc iframe sandboxed with "allow-scripts allow-forms", so its origin is opaque.
// The sandbox stops it from navigating the window or opening one, but not from navigating itself, which
// would fetch any URL: a subframe whose origin is opaque may only load its own document, about:srcdoc or
// about:blank.
//
// Electron 43.7.9: a frame's self-navigation fires will-frame-navigate with frame.origin === "null" and an
// empty frame.url, and preventDefault() stops it before any request leaves.
//
// A frame that has not loaded anything yet reads "null" as well, so the published-site preview beside the chat
// (a frame with a real origin once loaded) is let through when the page that holds it gives it its address:
// the initiator is the frame's parent and the parent's origin is not opaque.

const OWN_DOCUMENTS = new Set(["about:srcdoc", "about:blank"]);

/**
 * @param {{ isMainFrame?: boolean, url?: string, frame?: { origin?: string, parent?: { frameTreeNodeId?: number } | null } | null, initiator?: { frameTreeNodeId?: number, origin?: string } | null } | null | undefined} details
 * @returns {boolean} false when the navigation must be cancelled
 */
export function appFrameNavigationAllowed(details) {
  if (!details || details.isMainFrame) return true;
  // A link to a fragment of the page itself stays inside its own document.
  const url = typeof details.url === "string" ? details.url.split("#")[0] : "";
  if (OWN_DOCUMENTS.has(url)) return true;
  let origin;
  try {
    origin = details.frame?.origin;
  } catch {
    // Electron throws reading a frame whose render frame is gone ("Render frame was disposed…"), as for a
    // frame that navigates again right after a cancelled navigation. A frame nobody can read is not let through.
    return false;
  }
  return origin !== "null" || givenByOpenParent(details);
}

/** @param {{ frame?: { parent?: { frameTreeNodeId?: number } | null } | null, initiator?: { frameTreeNodeId?: number, origin?: string } | null }} details */
function givenByOpenParent(details) {
  try {
    const parent = details.frame?.parent;
    const initiator = details.initiator;
    if (!parent || !initiator || typeof parent.frameTreeNodeId !== "number") return false;
    return initiator.frameTreeNodeId === parent.frameTreeNodeId && typeof initiator.origin === "string" && initiator.origin !== "null";
  } catch {
    return false;
  }
}
