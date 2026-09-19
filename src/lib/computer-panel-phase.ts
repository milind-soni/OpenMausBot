// Pure terminal-phase deciders for the Computer panel. The component keeps
// the async orchestration (status fetches, provisioning, retry timers); each
// backend family's ladder ends in exactly one call here, mapping a typed
// status snapshot to the phase the panel settles on plus any error copy to
// surface. Temporal phases ("checking", "starting") stay imperative in the
// component — the deciders only name the temporal hand-off ("awaiting-desktop",
// "provision", "ensure-box") and the caller drives it.
import type { Bot } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { resolveBoxPanelAction } from "@/lib/local-computer";
import { isActiveTurnRefusal, isRemoteScreenshotContention } from "@/lib/remote-desktop";

/** Everything the Computer panel can render. Shared so the deciders and the
 * component cannot drift apart. */
export type ComputerPanelPhase =
  | "checking"
  | "unconfigured"
  | "starting"
  | "busy-box"
  | "ready"
  | "vm"
  | "vm-unavailable"
  | "vps-unconfigured"
  | "vps-incompatible"
  | "vps-stopped"
  | "local"
  | "local-unavailable"
  | "auto-unavailable"
  | "team-box"
  | "show-ready-box"
  | "show-sleeping-box"
  | "show-pending-box"
  | "browser"
  | "off"
  | "error";

/** Error copy a decision wants surfaced: localized copy (rendered through
 * t(), with an optional problem and fallback), or raw server text. null
 * clears the panel's error line. */
export type PhaseError =
  | { kind: "localized"; key: LocaleKey; problem?: string | null; fallbackKey?: LocaleKey }
  | { kind: "text"; text: string };

/** Managed-VPS status as the panel reads it. */
export interface VpsComputerStatus {
  configured: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  ready: boolean;
  problem: string | null;
}

/** Local VM status as the panel reads it. */
export interface LocalVmStatus {
  mode: "shared" | "per-bot";
  max_instances: number;
  image: boolean;
  create_supported: boolean;
  container: "running" | "stopped" | "missing";
  imageMatches: boolean;
  managed: boolean;
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  viewer_url: string;
}

/** Raw `GET computer` status as the Box ladder reads it. The fields are
 * untyped on the wire; each is checked at this boundary exactly as the
 * panel used to check it inline. */
export interface BoxComputerStatusSnapshot {
  configured?: unknown;
  box?: { state?: unknown } | null;
  teamComputer?: { id?: unknown; name?: unknown } | null;
  problem?: unknown;
}

/** A provision attempt's outcome as the VPS ladder reads it. */
export interface VpsProvisionSnapshot {
  ready?: unknown;
  problem?: string | null;
}

/** Phases the selected destination decides on its own, before any backend
 * call. Auto without a resolved surface has nothing to show; Off is Off;
 * browser-only bots own no desktop — the Browser tab is their whole screen,
 * so this tab must not wake a box or start host capture. null means the
 * selected backend family resolves its own phase. */
export function decideSelectionPhase(
  computer: Bot["computer"],
): "auto-unavailable" | "off" | "browser" | null {
  if (computer === undefined) return "auto-unavailable";
  if (computer === "off") return "off";
  if (computer === "browser") return "browser";
  return null;
}

/** Local capture needs the desktop capabilities read, a host that allows it,
 * and an engine that supports it; anything less is the repair path. The
 * engine error is decided by the engine check alone, exactly as before. */
export function decideLocalPhase(selection: {
  capabilitiesReady: boolean;
  localAvailable: boolean;
  providerSupportsLocal: boolean;
}): { phase: "local" | "local-unavailable"; error: PhaseError | null } {
  const ok = selection.capabilitiesReady && selection.localAvailable && selection.providerSupportsLocal;
  return {
    phase: ok ? "local" : "local-unavailable",
    error: selection.providerSupportsLocal ? null : { kind: "localized", key: "computer.err.localEngine" },
  };
}

/** True while a healthy VM container is still bringing up its desktop: the
 * temporal wait in the Local VM ladder. The caller keeps checking and counts
 * the attempts; 15 is the give-up point, after which the terminal decider
 * below reports the repair path instead. */
export function isVmAwaitingDesktop(status: LocalVmStatus, readinessAttempts: number): boolean {
  return !status.ready &&
    status.container === "running" &&
    status.imageMatches &&
    status.managed &&
    status.network === "loopback" &&
    status.security === "hardened" &&
    status.persistence === "durable" &&
    !status.desktopReady &&
    readinessAttempts < 15;
}

/** The Local VM terminal ladder. A failed status request (null) and a
 * missing engine land on the same unavailable phase, with different copy. */
export function decideVmPhase(selection: {
  vmSupported: boolean;
  /** null when the status request failed. */
  status: LocalVmStatus | null;
}): { phase: "vm" | "vm-unavailable"; error: PhaseError | null } {
  if (!selection.vmSupported) {
    return { phase: "vm-unavailable", error: { kind: "localized", key: "computer.err.vmEngine" } };
  }
  const status = selection.status;
  if (!status) return { phase: "vm-unavailable", error: null };
  if (status.ready) return { phase: "vm", error: null };
  const canCreateHere =
    status.mode === "per-bot" &&
    status.container === "missing" &&
    status.image &&
    status.create_supported;
  return {
    phase: "vm-unavailable",
    error: canCreateHere
      ? null
      : { kind: "localized", key: "computer.err.vmOpenSettings", problem: status.problem, fallbackKey: "computer.err.vmNotReady" },
  };
}

export type VpsPhaseDecision =
  | { phase: "vps-unconfigured" | "ready" | "vps-incompatible" | "vps-stopped"; error: PhaseError | null }
  /** The temporal hand-off: the person can act, so provisioning starts. */
  | { phase: "provision"; error: null };

/** The managed-VPS ladder, in the panel's exact precedence. App updates can
 * bump IMAGE_LAYER_VERSION while this bot still has a managed container from
 * the previous release; provision refuses to overwrite it by design, so the
 * incompatible case surfaces the explicit replacement path instead of a
 * request that can only 409. */
export function decideVpsPhase(selection: {
  status: VpsComputerStatus;
  canManageCloud: boolean;
  autoStartVps: boolean | undefined;
}): VpsPhaseDecision {
  const status = selection.status;
  if (!status.configured) {
    return { phase: "vps-unconfigured", error: { kind: "localized", key: "computer.err.vpsAlias" } };
  }
  if (status.ready) return { phase: "ready", error: null };
  if (status.managed && status.container !== "missing" && !status.imageMatches) {
    return {
      phase: "vps-incompatible",
      error: status.problem === null ? null : { kind: "text", text: status.problem },
    };
  }
  if (selection.canManageCloud) return { phase: "provision", error: null };
  return {
    phase: status.container === "stopped" ? "vps-stopped" : "vps-unconfigured",
    error: {
      kind: "localized",
      key: selection.autoStartVps ? "computer.err.vpsAuto" : "computer.err.vpsManual",
      problem: status.problem,
      fallbackKey: "computer.err.vpsNoContainer",
    },
  };
}

/** A provision attempt settles the panel: ready, or the problem with the
 * generic not-ready copy behind it (only null/undefined fall through to the
 * fallback — an empty problem string is shown as-is). */
export function decideVpsProvisionPhase(
  result: VpsProvisionSnapshot,
): { phase: "ready" | "error"; error: PhaseError | null } {
  if (result.ready) return { phase: "ready", error: null };
  const problem = result.problem ?? null;
  return {
    phase: "error",
    error: problem === null ? { kind: "localized", key: "computer.err.vpsNotReady" } : { kind: "text", text: problem },
  };
}

export type BoxPhaseDecision =
  | {
      phase: "unconfigured" | "team-box" | "ready" | "busy-box" | "show-ready-box" | "show-sleeping-box" | "show-pending-box" | "local" | "auto-unavailable";
      error: PhaseError | null;
    }
  /** The temporal hand-off: explicit Cloud may create or wake its Box. */
  | { phase: "ensure-box"; error: null };

/** The Box/Cloud ladder, in the panel's exact precedence: explicit Cloud
 * with no Box key at all; an inherited team Box (a shared resource, never a
 * private Cloud selection or a host fallback); a ready Box the current turn
 * already owns (provisioning would be refused (409) and is not needed —
 * going straight to ready lets the turn's live frames and the screenshot
 * poll show what the bot is doing); the passive show-* observations; and
 * finally provisioning, which only an explicit Cloud choice may start. */
export function decideBoxPhase(selection: {
  computer: Bot["computer"];
  canManageCloud: boolean;
  canUseCloud: boolean;
  busy?: boolean;
  status: BoxComputerStatusSnapshot;
}): BoxPhaseDecision {
  const status = selection.status;
  const action = resolveBoxPanelAction({
    computer: selection.computer === "cloud" && selection.canManageCloud ? "cloud" : undefined,
    configured: Boolean(status.configured),
    boxState: typeof status.box?.state === "string" ? status.box.state : null,
    canUseCloud: selection.canUseCloud,
    // The panel never falls back to host capture for Auto.
    autoLocal: false,
    teamComputer: typeof status.teamComputer?.id === "string" && typeof status.teamComputer?.name === "string",
    busy: selection.busy,
  });
  if (!status.configured && selection.computer === "cloud" && !status.teamComputer) {
    return { phase: "unconfigured", error: null };
  }
  if (action === "team-box") {
    return {
      phase: "team-box",
      error: typeof status.problem === "string" ? { kind: "text", text: status.problem } : null,
    };
  }
  if (action === "attach-ready-box" || (selection.computer === "cloud" && action === "show-ready-box")) {
    return { phase: "ready", error: null };
  }
  if (action === "ensure-box") return { phase: "ensure-box", error: null };
  return { phase: action, error: null };
}

/** A failed Box resolve, triaged. A turn that started while provision was in
 * flight is a wait, not a fault; and the panel's own screenshot poll holds
 * the box's lifecycle claim while it captures, so a provision landing
 * mid-capture is refused with a different 409 that is also a wait — the
 * caller re-resolves shortly instead of showing the fault this panel exists
 * to stop showing. */
export function decideBoxErrorPhase(cause: unknown): { phase: "busy-box" | "checking" | "error" } {
  if (isActiveTurnRefusal(cause)) return { phase: "busy-box" };
  if (isRemoteScreenshotContention({
    status: Number((cause as { status?: unknown })?.status ?? 0),
    message: String((cause as { message?: unknown })?.message ?? ""),
  })) {
    return { phase: "checking" };
  }
  return { phase: "error" };
}
