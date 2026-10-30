import type { CompanionAccountState } from "../types/ogb";
import { t } from "./i18n";
import type { CompanionEndpoint, CompanionPairingRouteMode } from "./companion-pairing";

export type PhoneSetupPhase = "intro" | "sign-in" | "verifying" | "qr" | "success";

export interface PhoneSetupFlowState {
  active: boolean;
  localFallback: boolean;
  tailscaleFallback: boolean;
  baselineDeviceIds: string[];
  pairingAttempted: boolean;
  pairedDeviceName: string | null;
}

export type PhoneSetupEvent =
  | { type: "start"; deviceIds: string[] }
  | { type: "resume"; deviceIds: string[] }
  | { type: "use-local" }
  | { type: "use-tailscale" }
  | { type: "pairing-opened"; deviceIds: string[] }
  | { type: "paired"; deviceName: string }
  | { type: "reset" };

export const initialPhoneSetupFlowState: PhoneSetupFlowState = {
  active: false,
  localFallback: false,
  tailscaleFallback: false,
  baselineDeviceIds: [],
  pairingAttempted: false,
  pairedDeviceName: null,
};

/** User intent lives here so a refresh cannot turn a secure setup into local-only pairing. */
export function phoneSetupReducer(
  state: PhoneSetupFlowState,
  event: PhoneSetupEvent,
): PhoneSetupFlowState {
  switch (event.type) {
    case "start":
    case "resume":
      return {
        active: true,
        localFallback: false,
        tailscaleFallback: false,
        baselineDeviceIds: [...event.deviceIds],
        pairingAttempted: false,
        pairedDeviceName: null,
      };
    case "use-local":
      return {
        ...state,
        active: true,
        localFallback: true,
        tailscaleFallback: false,
        pairingAttempted: false,
      };
    case "use-tailscale":
      return {
        ...state,
        active: true,
        localFallback: false,
        tailscaleFallback: true,
        pairingAttempted: false,
      };
    case "pairing-opened":
      return {
        ...state,
        baselineDeviceIds: [...event.deviceIds],
        pairingAttempted: true,
      };
    case "paired":
      return { ...state, active: true, pairedDeviceName: event.deviceName };
    case "reset":
      return initialPhoneSetupFlowState;
  }
}

export type PhoneSetupAccountStatus = CompanionAccountState["status"] | "unavailable";

export interface PhoneSetupSnapshot {
  accountStatus: PhoneSetupAccountStatus;
  accountBusy: boolean;
  provisioning: boolean;
  provisioningTimedOut?: boolean;
  pairingOpen: boolean;
}

export const PHONE_SETUP_PROVISIONING_TIMEOUT_MS = 30_000;

export function derivePhoneSetupPhase(
  flow: PhoneSetupFlowState,
  snapshot: PhoneSetupSnapshot,
): PhoneSetupPhase {
  if (flow.pairedDeviceName) return "success";
  if (!flow.active) return "intro";
  if (snapshot.pairingOpen || flow.pairingAttempted) return "qr";
  if (snapshot.provisioningTimedOut) return "sign-in";
  if (flow.localFallback || flow.tailscaleFallback) return "verifying";
  if (snapshot.accountStatus === "signed-out" || snapshot.accountStatus === "unavailable") {
    return "sign-in";
  }
  if (snapshot.accountStatus === "error") return "sign-in";
  if (snapshot.accountBusy || snapshot.provisioning) return "verifying";
  return "verifying";
}

export type CompanionPairingMode =
  | "local-only"
  | "hosted-startable"
  | "hosted-connecting"
  | "hosted-ready";

export interface PhoneSetupCompanionSnapshot {
  enabled: boolean;
  endpoints?: CompanionEndpoint[];
}

export async function preparePhonePairingRoute<State extends { enabled: boolean; error?: string }>(
  routeMode: CompanionPairingRouteMode,
  alreadyEnabled: boolean,
  actions: {
    read: () => Promise<State>;
    start: () => Promise<State>;
    refreshTailscale: () => Promise<State>;
    shouldContinue?: () => boolean;
  },
): Promise<State> {
  let state = await (alreadyEnabled ? actions.read() : actions.start());
  if (
    alreadyEnabled
    && !state.enabled
    && (actions.shouldContinue?.() ?? true)
  ) {
    state = await actions.start();
  }
  if (
    routeMode === "tailscale"
    && state.enabled
    && !state.error
    && (actions.shouldContinue?.() ?? true)
  ) {
    state = await actions.refreshTailscale();
  }
  return state;
}

/** Automatic setup is hosted-HTTPS only, so a tailnet route cannot silently replace hosted access. */
export const companionPairingMode = (
  account: CompanionAccountState | null,
  companion: PhoneSetupCompanionSnapshot | null,
): CompanionPairingMode => {
  if (companion?.endpoints?.some((endpoint) => endpoint.kind === "hosted")) {
    return "hosted-ready";
  }
  if (!account?.available || account.status === "signed-out" || account.status === "error") {
    return "local-only";
  }
  if (account.status === "ready" && !companion?.enabled) return "hosted-startable";
  return "hosted-connecting";
};

export type PhonePairingGate = "open" | "start" | "wait" | "account-required";

export function phonePairingGate(
  account: CompanionAccountState | null,
  companion: PhoneSetupCompanionSnapshot | null,
  explicitRoute: boolean,
): PhonePairingGate {
  if (explicitRoute) return "open";
  switch (companionPairingMode(account, companion)) {
    case "hosted-ready":
      return "open";
    case "hosted-startable":
      return "start";
    case "hosted-connecting":
      return "wait";
    case "local-only":
      return "account-required";
  }
}

export function shouldPrepareSecureAddress(
  routeMode: CompanionPairingRouteMode,
  gate: PhonePairingGate,
  account: CompanionAccountState | null,
): boolean {
  if (routeMode !== "automatic") return false;
  if (gate === "open") return true;
  return gate === "wait"
    && account?.available === true
    && (account.status === "ready" || account.status === "connecting");
}

export function secureAddressRequestLapsed(
  account: CompanionAccountState | null,
  companion: PhoneSetupCompanionSnapshot | null,
): boolean {
  return account?.available === true
    && account.status === "ready"
    && !account.endpoint
    && phonePairingGate(account, companion, false) === "wait";
}

export function newlyPairedDevice<T extends { id: string; name: string }>(
  baselineDeviceIds: string[],
  devices: T[],
): T | null {
  const baseline = new Set(baselineDeviceIds);
  return devices.find((device) => !baseline.has(device.id)) ?? null;
}

export function newlyPairedDeviceForFlow<T extends { id: string; name: string }>(
  flow: Pick<PhoneSetupFlowState, "active" | "baselineDeviceIds" | "pairingAttempted" | "pairedDeviceName">,
  devices: T[],
): T | null {
  if (!flow.active || !flow.pairingAttempted || flow.pairedDeviceName) return null;
  return newlyPairedDevice(flow.baselineDeviceIds, devices);
}

export function phoneSetupBaseline<T extends { id: string }>(devices: T[] | null): string[] | null {
  return devices ? devices.map((device) => device.id) : null;
}

export function shouldArmPhoneSetupProvisioningTimeout(
  flow: Pick<PhoneSetupFlowState, "active">,
  snapshot: Pick<PhoneSetupSnapshot, "provisioning" | "provisioningTimedOut">,
): boolean {
  return flow.active && snapshot.provisioning && !snapshot.provisioningTimedOut;
}

export interface PhonePairingAttemptLock {
  generation: number | null;
}

export function claimPhonePairingAttempt(
  lock: PhonePairingAttemptLock,
  generation: number,
): boolean {
  if (lock.generation === generation) return false;
  lock.generation = generation;
  return true;
}

export function releasePhonePairingAttempt(
  lock: PhonePairingAttemptLock,
  generation: number,
): boolean {
  if (lock.generation !== generation) return false;
  lock.generation = null;
  return true;
}

export interface PhonePairingQueuedRequest {
  generation: number;
}

export interface PhonePairingAttemptQueue<TRequest extends PhonePairingQueuedRequest> {
  active: TRequest | null;
  pending: TRequest | null;
}

export type PhonePairingQueueDecision = "start" | "queued" | "duplicate";

/** A newer request replaces the pending one, never the active one, so a late POST cannot replace a newer QR. */
export function queuePhonePairingAttempt<TRequest extends PhonePairingQueuedRequest>(
  queue: PhonePairingAttemptQueue<TRequest>,
  request: TRequest,
): PhonePairingQueueDecision {
  if (queue.active?.generation === request.generation
    || queue.pending?.generation === request.generation) return "duplicate";
  if (!queue.active) {
    queue.active = request;
    return "start";
  }
  queue.pending = request;
  return "queued";
}

export function completePhonePairingAttempt<TRequest extends PhonePairingQueuedRequest>(
  queue: PhonePairingAttemptQueue<TRequest>,
  generation: number,
): TRequest | null {
  if (queue.active?.generation !== generation) return null;
  const next = queue.pending;
  queue.active = next;
  queue.pending = null;
  return next;
}

export function invalidatePhonePairingAttempt(
  queue: PhonePairingAttemptQueue<PhonePairingQueuedRequest>,
  generation: number,
): void {
  if (queue.pending?.generation === generation) queue.pending = null;
}

interface PhonePairingWindowSnapshot {
  pairing: { code?: string; expiresAt?: number; token: string } | null;
}

const PAIRING_OPEN_FAILURE_MESSAGE =
  "Device pairing did not open. Open Advanced & troubleshooting, confirm Remote access is on, then try again.";

export function companionPairingOpenFailure(
  companion: PhonePairingWindowSnapshot & { enabled: boolean; error?: string },
  previousToken: string | null = null,
  now = Date.now(),
): string | null {
  const stateFailure = companionStartFailure(companion);
  if (stateFailure) return stateFailure;
  const pairing = companion.pairing;
  if (
    !pairing
    || pairing.token === previousToken
    || !/^omb_pair_[A-Za-z0-9_-]{43}$/.test(pairing.token)
    || !/^\d{6}$/.test(pairing.code ?? "")
    || !Number.isFinite(pairing.expiresAt)
    || (pairing.expiresAt ?? 0) <= now
  ) {
    return PAIRING_OPEN_FAILURE_MESSAGE;
  }
  return null;
}

/** Ownership is checked again right before the close, so an older completion cannot cancel a newer QR. */
export async function closePhonePairingIfOwned<TClosed>(
  opened: PhonePairingWindowSnapshot,
  current: () => Promise<PhonePairingWindowSnapshot>,
  close: () => Promise<TClosed>,
  mayClose: () => boolean,
): Promise<boolean> {
  const token = opened.pairing?.token;
  if (!token || !mayClose()) return false;
  let latest: PhonePairingWindowSnapshot;
  try {
    latest = await current();
  } catch {
    return false;
  }
  if (!mayClose() || latest.pairing?.token !== token) return false;
  try {
    await close();
    return true;
  } catch {
    return false;
  }
}

export async function keepPhonePairingIfCurrent<T, TClosed>(
  open: () => Promise<T>,
  close: (opened: T) => Promise<TClosed>,
  isCurrent: () => boolean,
): Promise<T | null> {
  const result = await open();
  if (isCurrent()) return result;
  await close(result).catch(() => {});
  return null;
}

export interface PhoneSetupPollTimer {
  set: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout>) => void;
}

export function startNonOverlappingPhoneSetupPoll<T>(
  poll: () => Promise<T>,
  intervalMs: number,
  timer: PhoneSetupPollTimer = {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: (handle) => clearTimeout(handle),
  },
): () => void {
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (stopped) return;
    handle = timer.set(() => {
      void Promise.resolve()
        .then(poll)
        .catch(() => {})
        .finally(schedule);
    }, intervalMs);
  };
  schedule();
  return () => {
    stopped = true;
    if (handle !== null) timer.clear(handle);
  };
}

const START_FAILURE_MESSAGE =
  "Remote access could not start. Open Advanced & troubleshooting, then try turning Remote access on again.";

export function companionStartFailure(
  companion: Pick<PhoneSetupCompanionSnapshot, "enabled"> & { error?: string },
): string | null {
  if (companion.enabled && !companion.error) return null;
  return companion.error?.trim() || START_FAILURE_MESSAGE;
}

const REQUEST_REFERENCE =
  /\bReference:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.?/i;
const IPC_REJECTION =
  /^Error invoking remote method ['"][^'"\r\n]+['"]:\s*(?:Error:\s*)?/i;
const PUBLIC_ACCOUNT_MESSAGES = [
  /^Enter a valid email address\.$/,
  /^The secure connection request (?:was not accepted|was not allowed)\./,
  /^That code (?:is not valid|expired)\./,
  /^Your sign-in expired\./,
  /^OpenMausBot could not reach its secure connection service\./,
  /^Too many attempts were made\./,
  /^This computer was reconnected too often\./,
  /^This account has reached its computer limit\./,
  /^This computer is already connected\./,
  /^The secure connection (?:is still being prepared|service could not finish setup|is still being removed)\./,
  /^Secure HTTPS links are temporarily full\./,
  /^Secure access is not available right now\./,
  /^The secure connection service (?:had a problem|returned an unexpected response|is busy right now)\./,
  /^The secure connection request could not be completed\./,
];

/** Electron prefixes rejected IPC errors with its channel machinery; keep that out of product copy. */
export function normalizePhoneSetupActionError(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error ? cause.message : "";
  const unwrapped = raw.replace(IPC_REJECTION, "").replace(/^Error:\s*/i, "").trim();
  const reference = unwrapped.match(REQUEST_REFERENCE)?.[1] ?? "";
  const message = unwrapped.replace(REQUEST_REFERENCE, "").trim();
  const forbiddenCodeRequest =
    /remote method ['"]companion-account:request-code['"]/i.test(raw)
    && message.startsWith("The secure connection request was not allowed.");
  const publicMessage = !forbiddenCodeRequest
    && PUBLIC_ACCOUNT_MESSAGES.some((pattern) => pattern.test(message))
    ? message
    : fallback;
  return reference ? t("phone.error.reference", { message: publicMessage, reference }) : publicMessage;
}
