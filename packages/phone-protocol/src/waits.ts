/** What a wait (wait_until) can wait for. */
export const WAIT_KINDS = ["url_contains", "url_missing", "file_exists", "file_missing", "file_changed", "process_running", "process_gone", "bot_idle"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];
/** How long a wait lasts unless it fires first, in hours. */
export const WAIT_HOURS = { default: 24, max: 168 } as const;
