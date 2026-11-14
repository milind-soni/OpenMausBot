import type { ReactNode } from "react";

import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import type { LocaleKey } from "@/locales";
import { useTeamPeople } from "@/state/team-people";

/** What only an admin may use: anyone else reads why instead of controls the server would refuse. A team's member is
 * shown neither: what isn't theirs to change is left out. */
export function AdminOnly({ children, note = "settings.adminOnly.change" }: { children: ReactNode; note?: LocaleKey }) {
  const team = useTeamPeople() !== null;
  if (useOwnerOrAdmin() !== false) return children;
  return team ? null : <p data-admin-only className="text-[13px] text-ink-secondary">{t(note)}</p>;
}
