import { useState } from "react";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { t } from "@/lib/i18n";
import { SettingRow, Switch } from "./SettingsPrimitives";

const ANALYTICS_DOC_URL = "https://github.com/milind-soni/OpenMausBot/blob/main/docs/analytics.md";

export function AnalyticsRow({ simple = false }: { simple?: boolean }) {
  const [on, setOn] = useState(analyticsEnabled);
  const subtitle = (
    <>
      {t(simple ? "settings.simple.analytics" : "settings.analytics.subtitle")}{" "}
      <a href={ANALYTICS_DOC_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
        {t(simple ? "settings.simple.analyticsLink" : "settings.analytics.link")}
      </a>
    </>
  );
  return (
    <SettingRow title={t("settings.analytics.title")} subtitle={subtitle}>
      <Switch
        checked={on}
        aria-label={t("settings.analytics.aria")}
        onClick={() => {
          const next = !on;
          setAnalyticsEnabled(next);
          setOn(next);
        }}
      />
    </SettingRow>
  );
}
