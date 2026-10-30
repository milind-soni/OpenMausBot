import type { ReactNode } from "react";

import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import type { LocaleKey } from "@/locales";

/** What only an admin may use: anyone else reads why instead of controls the server would refuse. */
export function AdminOnly({ children, note = "settings.adminOnly.change" }: { children: ReactNode; note?: LocaleKey }) {
  if (useOwnerOrAdmin() === false) return <p data-admin-only className="text-[13px] text-ink-secondary">{t(note)}</p>;
  return children;
}
