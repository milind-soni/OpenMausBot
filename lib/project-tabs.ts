/** Project tabs and the ?tab= names that open them. */
export type TabKey = "issues" | "code" | "assets" | "vault" | "feedback" | "settings";
/** What the Code tab lists: pull requests (default), commits or the repository's GitHub issues. */
export type CodeSection = "pulls" | "commits" | "issues";

export const TAB_KEYS: readonly TabKey[] = ["issues", "code", "assets", "vault", "feedback", "settings"];

/**
 * Older ?tab= names that still open the right place: "board" is Issues, "team" is Settings, and the former Repo and
 * Pull requests tabs are sections of Code.
 */
export const TAB_ALIASES: Readonly<Record<string, { tab: TabKey; section?: CodeSection }>> = {
  board: { tab: "issues" },
  team: { tab: "settings" },
  repo: { tab: "code", section: "commits" },
  pulls: { tab: "code", section: "pulls" },
};

/** The tab (and Code section) named by ?tab=. Unknown or missing names open Issues. */
export function tabFromQuery(value: string | null): { tab: TabKey; section?: CodeSection } {
  if (value && Object.hasOwn(TAB_ALIASES, value)) return TAB_ALIASES[value]!;
  return { tab: TAB_KEYS.includes(value as TabKey) ? value as TabKey : "issues" };
}
