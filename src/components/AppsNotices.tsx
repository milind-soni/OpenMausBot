import type { Bot, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

interface Props {
  filter: "all" | "connected" | "mcp" | "science";
  setupNotice: { key: LocaleKey; tone: "info" | "warning" } | null;
  botsWithoutApps: Bot[];
  remoteClient: boolean;
  whopConnected: boolean | null;
  featured: boolean;
  pillClass: string;
  close(): void;
  dispatch: ReturnType<typeof useStore>["dispatch"];
}

export function AppsNotices({ filter, setupNotice, botsWithoutApps, remoteClient, whopConnected, featured, pillClass, close, dispatch }: Props) {
  const apps = filter !== "mcp" && filter !== "science";
  return (
    <>
      {setupNotice && apps && (
        <div
          className={cn(
            "mb-3 rounded-xl px-4 py-3 text-[13px]",
            setupNotice.tone === "warning" ? "bg-warning/10 text-warning" : "bg-control/50 text-ink-secondary",
          )}
        >
          {t(whopConnected ? "whop.otherAppsSetup" : setupNotice.key)}{" "}
          <button
            className={cn(
              "font-medium underline underline-offset-2",
              setupNotice.tone === "info" && "text-ink",
              remoteClient && "hidden",
            )}
            onClick={() => {
              close();
              dispatch({ type: "toggleAppSettings", open: true, section: "connections" });
            }}
          >
            {t("connectors.openSettings")}
          </button>
        </div>
      )}
      {botsWithoutApps.length > 0 && filter !== "science" && (
        <div className="mb-3 rounded-xl bg-control/50 px-4 py-3 text-[12.5px] leading-relaxed text-ink-secondary">
          <span className="font-medium text-ink">{t("connectors.perBot.title")}</span>{" "}
          {t("connectors.perBot.body")}
          <div className="mt-2 flex flex-wrap gap-2">
            {botsWithoutApps.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => dispatch({ type: "updateBot", botId: candidate.id, patch: { composio: true } })}
                className={cn(pillClass, "bg-control text-ink hover:bg-raised-hover")}
              >
                {t("connectors.perBot.allow", { name: candidate.name })}
              </button>
            ))}
          </div>
        </div>
      )}
      {featured && apps && (
        <div className="mb-3 text-[12px] text-ink-secondary">
          {t("connectors.featuredBefore")}{" "}
          <button
            className="underline underline-offset-2 hover:text-ink"
            onClick={() => {
              close();
              dispatch({ type: "toggleAppSettings", open: true });
            }}
          >
            {t("connectors.updateKey")}
          </button>{" "}
          {t("connectors.featuredAfter")}
        </div>
      )}
    </>
  );
}
