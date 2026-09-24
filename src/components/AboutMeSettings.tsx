import { useEffect, useSyncExternalStore } from "react";
import { CircleHelp } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { createAboutMeDraft } from "./about-me-draft";

const drafts = new WeakMap<object, ReturnType<typeof createAboutMeDraft>>();

export function AboutMeSettings() {
  const { state, dispatch } = useStore();
  const confirmed = state.config?.profile?.aboutMe ?? "";
  let controller = drafts.get(dispatch);
  if (!controller) {
    controller = createAboutMeDraft(confirmed, async (sent) => {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT", body: JSON.stringify({ profile: { aboutMe: sent } }), timeoutMs: 10_000,
      });
      dispatch({ type: "profileSaved", profile: { aboutMe: config.profile?.aboutMe ?? sent } });
    });
    drafts.set(dispatch, controller);
  }
  const { value, status } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { flush } = controller;
  useEffect(() => { controller.confirm(confirmed); }, [controller, confirmed]);
  useEffect(() => () => { void flush(); }, [flush]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label htmlFor="profile-about-me" className="text-[14px] text-ink">{t("settings.profile.aboutMe")}</label>
        <details className="group relative">
          <summary title={t("settings.profile.aboutMeHelp")} aria-label={t("settings.profile.aboutMeHelp")}
            className="flex size-6 cursor-pointer list-none items-center justify-center rounded-md text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 [&::-webkit-details-marker]:hidden">
            <CircleHelp size={14} aria-hidden="true" />
          </summary>
          <p className="absolute left-0 z-30 mt-1 w-56 rounded-xl border border-hairline bg-panel p-3 text-[12px] text-ink-secondary shadow-xl">
            {t("settings.profile.aboutMeHelp")}
          </p>
        </details>
      </div>
      <textarea id="profile-about-me" value={value} rows={5} maxLength={24_000}
        onChange={(event) => controller.edit(event.target.value)}
        onBlur={() => void flush()}
        className="min-h-[120px] w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink focus:border-hairline focus:outline-none"
      />
      <div className="min-h-4 text-[12px]" role="status">
        {status === "saving" && <span className="text-ink-secondary">{t("settings.profile.saving")}</span>}
        {status === "saved" && <span className="text-success">{t("settings.profile.saved")}</span>}
        {status === "error" && <span className="text-danger">{t("settings.profile.saveError")} {" "}
          <button type="button" onClick={() => void flush()} className="underline">{t("settings.profile.retry")}</button>
        </span>}
      </div>
    </div>
  );
}
