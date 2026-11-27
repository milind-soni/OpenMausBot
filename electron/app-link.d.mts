export declare const APP_LINK_PREFIX: string;
export declare const LOCAL_APP_ID: RegExp;
export function validAppId(id: unknown): id is string;
export function appLink(id: string): string;
/** The link a launcher on this computer opens: the app in a window of its own. */
export function launcherLink(id: string): string;
/** `{ id, window }` for openmausbot://app/<id> (a trailing slash allowed, `?window=1` the only query), else null. */
export function parseAppLink(value: unknown): { id: string; window: boolean } | null;
export function appLinkFromCommandLine(argv: unknown): { id: string; window: boolean } | null;
