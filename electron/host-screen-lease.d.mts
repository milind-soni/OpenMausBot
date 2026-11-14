/** Said when the desktop's own server could not answer whether its screen is free: never a person. */
export function screenCheckFailedText(detail: string): string;
/** `hostControl` for createComputerSharing: this computer's screen lock, taken from the desktop's own server. */
export function createHostScreenLease(options: {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  url: () => string;
  headers?: () => Record<string, string>;
  timeoutMs?: number;
}): (id: string, signal: AbortSignal) => Promise<{ renew(): Promise<void>; release(): Promise<void> }>;
