import { Loader2, Plus } from "lucide-react";

import { t } from "@/lib/i18n";
import { catalogCopy, catalogFaces, type TeamCatalogEntry } from "@/lib/team-catalog";
import { creditShown } from "@/lib/template-share";
import { TemplateFaces } from "./TemplateCard";

/** A community template in the Templates gallery: the same card the ready-made bots have, with every bot's face. */
export function TeamCatalogCard({ entry, busy, disabled, onAdd }: {
  entry: TeamCatalogEntry;
  busy: boolean;
  disabled: boolean;
  onAdd: () => void;
}) {
  const copy = catalogCopy(entry);
  const credit = creditShown(entry.author);
  const bots = entry.members === 1 ? t("template.botsOne") : t("template.botsMany", { count: entry.members });
  const details = [
    entry.skills.length > 0 && (entry.skills.length === 1 ? t("template.skillsOne") : t("template.skillsMany", { count: entry.skills.length })),
    entry.requires.apps.length > 0 && entry.requires.apps.join(", "),
    entry.setupMinutes && t("templates.minutes", { count: entry.setupMinutes }),
  ].filter(Boolean).join(" · ");
  return (
    <article data-catalog-template={entry.slug} className="flex flex-col rounded-2xl border border-hairline/40 bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <TemplateFaces avatars={catalogFaces(entry)} size={36} on="card" />
        <button
          type="button"
          onClick={onAdd}
          disabled={disabled}
          aria-label={busy ? undefined : t("orgLibrary.addAria", { name: copy.name })}
          className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-raised px-3 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Plus size={14} aria-hidden="true" />}
          {busy ? t("templates.loadingShort") : t("common.add")}
        </button>
      </div>
      <h4 dir="auto" className="mt-3 truncate text-[14px] font-medium text-ink" title={copy.name}>{copy.name}</h4>
      <p dir="auto" className="truncate text-[12px] text-ink-secondary">{bots} · {entry.category}</p>
      {credit && <p dir="auto" data-catalog-published-by className="truncate text-[12px] text-ink-tertiary" title={credit}>{t("template.publishedBy", { name: credit })}</p>}
      <p dir="auto" className="mt-2 line-clamp-3 text-[13px] leading-[1.45] text-ink-secondary">{copy.outcome ?? copy.summary}</p>
      {details && <p className="mt-auto truncate pt-2 text-[12px] text-ink-tertiary" title={details}>{details}</p>}
    </article>
  );
}
