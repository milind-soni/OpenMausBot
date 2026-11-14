// The CDP methods omb-cdp may send, per kind of session. Pages detect a CDP
// client through the Runtime domain: with Runtime enabled, V8 builds console
// previews (an Error's getters run twice per console.log), which
// deviceandbrowserinfo.com and others report as isAutomatedWithCDP (measured on
// Chrome 153). Everything here is refused before it reaches the browser.

export type SessionKind = "browser" | "page" | "frame" | "worker" | "other";

export interface SendFlags {
  /** A deliberate main-world evaluation: the page can observe it. */
  pageWorld?: boolean;
}

const NEVER: readonly RegExp[] = [
  /^Runtime\.enable$/,
  /^Runtime\.addBinding$/,
  /^Console\./,
  /^Debugger\./,
  /^Profiler\./,
  /^HeapProfiler\./,
  /^Tracing\./,
  /^SystemInfo\./,
  /^Network\.getAllCookies$/,
];

const BROWSER = new Set([
  "Target.setDiscoverTargets",
  "Target.setAutoAttach",
  "Target.getTargets",
  "Target.getTargetInfo",
  "Target.createTarget",
  "Target.closeTarget",
  "Target.activateTarget",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Browser.getVersion",
  "Browser.setPermission",
  "Browser.resetPermissions",
  "Browser.setDownloadBehavior",
  "Browser.cancelDownload",
  "Browser.close",
  "Browser.getWindowForTarget",
  "Browser.getWindowBounds",
  "Browser.setWindowBounds",
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearCookies",
  "Storage.clearDataForOrigin",
]);

const PAGE = new Set([
  "Page.enable",
  "Page.setLifecycleEventsEnabled",
  "Page.navigate",
  "Page.navigateToHistoryEntry",
  "Page.getNavigationHistory",
  "Page.reload",
  "Page.stopLoading",
  "Page.getFrameTree",
  "Page.createIsolatedWorld",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.removeScriptToEvaluateOnNewDocument",
  "Page.setInterceptFileChooserDialog",
  "Page.handleJavaScriptDialog",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Page.screencastFrameAck",
  "Page.bringToFront",
  "Page.close",
  "DOM.getDocument",
  "DOM.describeNode",
  "DOM.resolveNode",
  "DOM.querySelector",
  "DOM.focus",
  "DOM.getContentQuads",
  "DOM.getBoxModel",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.getNodeForLocation",
  "DOM.setFileInputFiles",
  "DOM.getFrameOwner",
  "Accessibility.getFullAXTree",
  "Accessibility.queryAXTree",
  "Emulation.setUserAgentOverride",
  "Emulation.setFocusEmulationEnabled",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.clearDeviceMetricsOverride",
  "Network.enable",
  "Network.disable",
  "Network.getCookies",
  "Network.deleteCookies",
  "Network.setUserAgentOverride",
  "Log.enable",
  "Log.disable",
  "Fetch.enable",
  "Fetch.disable",
  "Fetch.continueRequest",
  "Fetch.continueWithAuth",
  "Fetch.fulfillRequest",
  "Fetch.failRequest",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.terminateExecution",
  "Runtime.runIfWaitingForDebugger",
  "Runtime.releaseObject",
  "Runtime.releaseObjectGroup",
  "Target.setAutoAttach",
  "Target.detachFromTarget",
]);

const PAGE_DOMAINS = [/^Input\./, /^WebAuthn\./];

const WORKER = new Set([
  "Emulation.setUserAgentOverride",
  "Network.setUserAgentOverride",
  "Runtime.runIfWaitingForDebugger",
  "Target.setAutoAttach",
]);

const OTHER = new Set(["Runtime.runIfWaitingForDebugger"]);

function allowed(kind: SessionKind, method: string): boolean {
  switch (kind) {
    case "browser":
      return BROWSER.has(method);
    case "page":
    case "frame":
      return PAGE.has(method) || PAGE_DOMAINS.some((domain) => domain.test(method));
    case "worker":
      return WORKER.has(method);
    case "other":
      return OTHER.has(method);
  }
}

/** Why `method` may not be sent on a session of this kind, or null when it may. */
export function methodRefusal(kind: SessionKind, method: string, params: Readonly<Record<string, unknown>>, flags: SendFlags = {}): string | null {
  if (NEVER.some((pattern) => pattern.test(method))) return `${method} is never sent: it lets pages detect the automation.`;
  if (!allowed(kind, method)) return `${method} is not on the driver's allowlist for ${kind} sessions.`;
  if (method === "Runtime.evaluate" && params.contextId === undefined && !flags.pageWorld) {
    return "Runtime.evaluate without a contextId runs in the page's own world; only an explicit page-world evaluation may do that.";
  }
  if (method === "Page.addScriptToEvaluateOnNewDocument" && (typeof params.worldName !== "string" || params.worldName === "")) {
    return "Page.addScriptToEvaluateOnNewDocument needs a worldName: scripts never run in the page's own world.";
  }
  return null;
}
