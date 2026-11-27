import { useEffect, useState } from "react";

import type { Bot } from "@/state/store";
import { packageProvenance, type OrgLibraryInstall, type OrgLibraryListing } from "@/lib/org-library";
import { useBotEditor } from "./BotEditorContext";

export function PackageProvenance({ bot }: { bot: Bot }) {
  const { request, draft } = useBotEditor();
  const [installs, setInstalls] = useState<OrgLibraryInstall[]>([]);
  const org = bot.installedPackage?.source === "org";

  useEffect(() => {
    if (!org || draft) return;
    let cancelled = false;
    request("/api/org-library")
      .then((listing: OrgLibraryListing) => { if (!cancelled) setInstalls(listing.installs ?? []); })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, org, draft]);

  const provenance = packageProvenance(bot.installedPackage, installs);
  if (!provenance) return null;
  return (
    <div className="rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">
      <div className="truncate">{provenance.line}</div>
      {provenance.withdrawn && <div className="mt-0.5 text-warning">{provenance.withdrawn}</div>}
    </div>
  );
}
