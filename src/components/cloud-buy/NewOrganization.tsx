// A new organization on the Team plan the person pays for, from the rail's ＋: a name and a color, then it is added at once
// (no checkout, nothing to pay) and its circle shows it being set up. Main asks the Admin; the page sees only what it says.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { CloudSwatch, OrganizationBlock } from "../../../electron/cloud-list.mjs";
import type { AddCloudView } from "../../../electron/cloud-rail.mjs";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { CLOUD_LIST_NAME_LIMIT, DEFAULT_SWATCH, swatchFill } from "@/lib/cloud-extra";
import { t } from "@/lib/i18n";
import { placeInitials, refreshPlaces } from "@/lib/places";
import type { LocaleKey } from "@/locales";
import { SwatchRadios } from "../SwatchRadios";
import { BackLink, FIELD, Heading, PRIMARY_WIDE } from "./parts";

const BLOCKED: Record<OrganizationBlock, LocaleKey> = { no_team_plan: "rail.orgNoPlan", limit: "rail.orgLimit", rate: "rail.orgRate", off: "rail.orgOff" };
type OrganizationAnswer = { outcome: "added" | "taken" | "unsupported" | "failed" } | { outcome: "blocked"; blocked: OrganizationBlock };

/** What main's answer means for the sheet: added (it closes), or the sentence to show. */
export function organizationProblem(answer: OrganizationAnswer | null): LocaleKey | null {
  if (answer?.outcome === "added") return null;
  return answer?.outcome === "taken" ? "rail.orgTaken" : answer?.outcome === "blocked" ? BLOCKED[answer.blocked] : "rail.orgFailed";
}

export function NewOrganization({ onBack, onClose }: { onBack: (() => void) | null; onClose: () => void }) {
  const [view, setView] = useState<AddCloudView | null>(null);
  const [name, setName] = useState(""), [color, setColor] = useState<CloudSwatch>(DEFAULT_SWATCH);
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState<LocaleKey | null>(null);
  useEffect(() => { void window.ogb?.cloudAdd?.state().then(setView, () => setView(null)); }, []);
  const facts = view?.signedIn ? view.organizations ?? null : null;
  // Closed for a reason this app doesn't know: the neutral word, never a limit it may not be at.
  const blocked = facts && !facts.canAdd ? facts.blocked ? BLOCKED[facts.blocked] : "rail.orgOff" : null;
  const shown = name.trim().replace(/\s+/g, " ");
  const create = async () => {
    if (!shown || busy || blocked) return;
    setBusy(true); setProblem(null);
    const answer = await window.ogb?.cloudAdd?.organization?.(shown, color).catch(() => null) ?? null;
    setBusy(false);
    const why = organizationProblem(answer);
    if (why) { setProblem(why); return; }
    track("rail_add", { step: "organization" });
    void refreshPlaces();
    onClose();
  };
  return <form data-place-add="organization" className="flex flex-col gap-4 px-[30px] pb-[26px] pt-7" onSubmit={(event) => { event.preventDefault(); void create(); }}>
    {onBack && <div><BackLink label={t("rail.back")} onClick={onBack} /></div>}
    <Heading title={t("rail.org")} sub={t("rail.orgLede")} />
    <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">{t("rail.orgName")}
      <input data-autofocus value={name} maxLength={CLOUD_LIST_NAME_LIMIT} placeholder={t("rail.orgPlaceholder")} disabled={busy} onChange={(event) => setName(event.target.value)} className={FIELD} />
    </label>
    <div className="flex flex-col gap-1.5">
      <span aria-hidden="true" className="text-[13px] font-medium text-ink">{t("rail.orgColor")}</span>
      <SwatchRadios value={color} onChange={setColor} label={t("rail.orgColor")} disabled={busy} />
    </div>
    <div className="flex items-center gap-3 rounded-xl border border-hairline/70 bg-card/70 px-4 py-3">
      <span aria-hidden="true" className={cn("grid size-10 shrink-0 place-items-center rounded-full text-[14px] font-semibold", color === "slate" ? "bg-raised text-ink" : "text-white")}
        style={color === "slate" ? undefined : { background: swatchFill(color) }}>{placeInitials(shown || t("rail.org"))}</span>
      <span className="min-w-0">
        <span data-org-preview className="block truncate text-[14px] font-semibold text-ink">{shown || t("rail.org")}</span>
        {facts && <span data-org-count className="block text-[13px] text-ink-secondary">{t("rail.orgCount", { count: Math.min(facts.count + 1, facts.max), max: facts.max })}</span>}
      </span>
    </div>
    {(blocked || problem) && <p role="alert" data-org-problem className="text-[13px] leading-relaxed text-danger">{t(blocked ?? problem!)}</p>}
    <button type="submit" className={PRIMARY_WIDE} disabled={busy || !shown || Boolean(blocked)}>
      {busy && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}{t("rail.orgCreate")}
    </button>
  </form>;
}
