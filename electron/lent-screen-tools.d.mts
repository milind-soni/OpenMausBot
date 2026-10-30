export const LENT_SCREEN_ARGUMENTS: Readonly<Record<string, Record<string, unknown>>>;
export const LENT_SCREEN_TOOLS: ReadonlySet<string>;
export function lentScreenArguments(name: unknown, input: unknown): { arguments: Record<string, unknown> } | { error: string };
export function lentScreenToolListing(tools: unknown): Array<Record<string, unknown>>;
