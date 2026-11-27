import { ExternalLink } from "lucide-react";

import { t } from "@/lib/i18n";

export function SlackSection({ managementUrl }: { managementUrl: string }) {
  return (
    <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-ink-secondary">
      <p>{t("botSlack.body")}</p>
      <a
        href={managementUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-fit items-center gap-2 rounded-lg bg-control px-3 py-2 font-medium text-ink hover:bg-control/70"
      >
        {t("botSlack.manage")} <ExternalLink size={14} aria-hidden="true" />
      </a>
    </div>
  );
}
