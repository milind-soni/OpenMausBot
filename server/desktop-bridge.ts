// The desktop private-message bridge — extracted verbatim from index.ts:
// Electron's utility-process parent port handle, the DesktopPrivateMessage
// union the host exchanges with the desktop surfaces, the guarded post that
// keeps credentials out of the renderer, and the per-launch mutation
// capability message that replaces the bootstrap deny-all token. index.ts
// wires createDesktopBridge at the region's original site and rebinds the
// functions from its result; the desktop approval machine, the phone
// secret bridge and the turn integrations receive postDesktopPrivateMessage
// from there. The desktopMutationToken / companionMutationToken lets stay
// in index.ts (the request gate and the loopback authority wiring read
// them there) and cross as get/set accessor pairs; utilityParentPort is
// module-internal, so index.ts's two parentPort listeners register and
// reply through onUtilityParentMessage / postUtilityParentMessage.
import type { BrowserCleanupWireRequest } from "./browser-lifecycle-cleanup.ts";
import type { WireBot } from "../shared/wire.ts";

export interface DesktopBridgeDeps {
  desktopMutationToken: { get(): string | undefined; set(value: string | undefined): void };
  companionMutationToken: { get(): string | undefined; set(value: string | undefined): void };
}

export function createDesktopBridge(deps: DesktopBridgeDeps) {
  const { desktopMutationToken, companionMutationToken } = deps;

// Electron's utility-process parent port is private to the desktop main
// process. It lets a slow first-time managed Composio registration arrive
// after first paint without putting the credential in the renderer or
// restarting the embedded server. Plain Node/dev launches have no parentPort.
type UtilityParentPort = {
  on(event: "message", listener: (event: { data?: object }) => void): void;
  postMessage(message: object): void;
};
// SAFETY: Electron's utility-process runtime is the only environment that
// supplies parentPort; plain Node intentionally leaves it absent.
const utilityParentPort = (process as NodeJS.Process & { parentPort?: UtilityParentPort }).parentPort;
type DesktopPrivateMessage = BrowserCleanupWireRequest | {
  type: "openmausbot:browser-control";
  botId: string;
  held: true;
} | {
  type: "openmausbot:phone-secret-save";
  requestId: string;
  target: string;
  value: string;
} | {
  type: "approval-trusted-mode-result" | "approval-trusted-mode-commit-result";
  requestId: string;
  ok: boolean;
  bot?: WireBot;
  error?: string;
} | {
  type: "approval-trusted-mode-confirm-result";
  requestId: string;
  ok: boolean;
  error?: string;
} | {
  type: "approval-trusted-mode-activate-result" | "approval-trusted-mode-finalize-result";
  requestId: string;
  ok: boolean;
  error?: string;
};
function postDesktopPrivateMessage(message: DesktopPrivateMessage): boolean {
  if (!utilityParentPort) return false;
  try {
    utilityParentPort.postMessage(message);
    return true;
  } catch (error) {
    console.error(`[desktop-sync] could not send private parent message: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
function applyDesktopMutationTokenMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const message = raw as Record<string, unknown>;
  if (message.type !== "openmausbot:desktop-mutation-token") return false;
  if (typeof message.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(message.token)) {
    throw new Error("invalid desktop mutation capability");
  }
  desktopMutationToken.set(message.token);
  if (typeof message.companionToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(message.companionToken)) {
    companionMutationToken.set(message.companionToken);
  }
  return true;
}

  return {
    postDesktopPrivateMessage,
    applyDesktopMutationTokenMessage,
    // The host's parentPort listeners register through this so the port
    // handle never leaves the module; a plain Node launch has no port and
    // the registration is silently skipped, exactly as before.
    onUtilityParentMessage(listener: (event: { data?: object }) => void): void {
      utilityParentPort?.on("message", listener);
    },
    // Raw reply channel for the managed-desktop handshake frames, which are
    // not DesktopPrivateMessage traffic; like the original direct posts it
    // is untyped beyond object and neither guards nor logs.
    postUtilityParentMessage(message: object): void {
      utilityParentPort?.postMessage(message);
    },
  };
}
