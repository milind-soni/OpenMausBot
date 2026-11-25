// Which of an ACP permission request's options an answer uses.
type PermissionOption = { optionId?: string; kind?: string; name?: string };

/** The option an allow or a reject picks, and the session-wide allow if there is one. `onceOnly` keeps both to the
 * `*_once` kinds, for a request whose approval must never outlast it. */
export function permissionOptions(options: readonly PermissionOption[], onceOnly: boolean) {
  const named = (match: (kind: string) => boolean) => options.find((o) => match(String(o.kind ?? "")) && typeof o.optionId === "string")?.optionId;
  return {
    optionFor: (want: "allow" | "reject"): string | null => named((kind) => kind === `${want}_once`) ?? (onceOnly ? undefined : named((kind) => kind.startsWith(want))) ?? null,
    optionAlways: onceOnly ? null : named((kind) => kind === "allow_always") ?? null,
  };
}

export const missingOptionNote = (agent: string, want: string) =>
  `${agent} offered no "${want}" permission option — cancelling the request instead of guessing`;
