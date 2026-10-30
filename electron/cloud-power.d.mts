/** The Admin's word on a Cloud whose plan sleeps when idle (the session's `cloud.power`). */
export interface CloudPower { state: "awake" | "asleep" | "waking"; since: number; sleeps: true }
export declare const CLOUD_POWER_HEADER: string;
export declare const BACKGROUND_HEADERS: Readonly<Record<string, string>>;
export declare const ASLEEP_HOLD_MS: number;
export declare const SIGNED_IN_MS: number;
export declare const WAKING_SIGNED_IN_MS: number;
export declare const WAKING_SHOWN_AFTER_MS: number;
export declare class CloudAsleepError extends Error {}
export declare function asleepAnswer(response: { status: number; headers?: { get(name: string): string | null } } | null | undefined): boolean;
export interface CloudPowerGate {
  /** Background work must not call My Cloud now. */
  asleep(): boolean;
  /** The Admin's word may have changed: work waiting for My Cloud resumes when it is awake. */
  changed(): void;
  awaiting(): boolean;
  signal(): AbortSignal;
  hold(): void;
  woke(): void;
  wait(signal?: AbortSignal): Promise<void>;
}
export declare function createCloudPowerGate(options?: {
  power?: () => CloudPower | null;
  wanted?: () => boolean;
  now?: () => number;
  holdMs?: number;
  setTimer?: (work: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): CloudPowerGate;
export declare function openSleepingCloud(options: {
  power: CloudPower | null;
  wake: () => Promise<unknown>;
  signedIn: (timeoutMs: number) => Promise<boolean>;
  waking?: (on: boolean) => void;
  setTimer?: (work: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): Promise<boolean>;
