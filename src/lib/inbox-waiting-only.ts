export const INBOX_WAITING_ONLY_KEY = "omb-inbox-waiting-only";

/** The Inbox's "Waiting for me" filter, remembered on this device. Storage may be blocked, so a failure is off. */
export function readInboxWaitingOnly(): boolean {
  try {
    return globalThis.localStorage?.getItem(INBOX_WAITING_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeInboxWaitingOnly(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(INBOX_WAITING_ONLY_KEY, on ? "1" : "0");
  } catch {}
}
