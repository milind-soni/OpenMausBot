import { useEffect, useSyncExternalStore } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { createAboutMeDraft } from "./about-me-draft";

const drafts = new WeakMap<object, ReturnType<typeof createAboutMeDraft>>();

export function EveryBotRules() {
  const { state, dispatch } = useStore();
  const confirmed = state.config?.everyBotRules;
  let controller = drafts.get(dispatch);
  if (!controller) {
    controller = createAboutMeDraft(confirmed ?? "", async (sent) => {
      const config = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ everyBotRules: sent }), timeoutMs: 10_000 });
      dispatch({ type: "configStatus", config });
    });
    drafts.set(dispatch, controller);
  }
  const { value, status } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { confirm, edit, flush } = controller;
  useEffect(() => { confirm(confirmed ?? ""); }, [confirm, confirmed]);
  useEffect(() => () => { void flush(); }, [flush]);
  // The server sends the rules only to someone who may change them.
  if (confirmed === undefined) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="profile-every-bot-rules" className="text-[13px] font-medium leading-[18px] text-ink">{t("settings.profile.everyBotRules")}</label>
      <textarea id="profile-every-bot-rules" value={value} rows={4} maxLength={24_000}
        placeholder={t("settings.profile.everyBotRulesPlaceholder")}
        onChange={(event) => edit(event.target.value)}
        onBlur={() => void flush()}
        className="min-h-[96px] w-full resize-none rounded-lg border-[0.5px] border-(--settings-edge) bg-app px-2.5 py-1.5 text-[13px] leading-5 text-ink placeholder:text-ink-tertiary focus:border-ink/25 focus:outline-none"
      />
      <div className="text-[12px] leading-4 empty:hidden" role="status">
        {status === "saving" && <span className="text-ink-secondary">{t("settings.profile.saving")}</span>}
        {status === "saved" && <span className="text-success">{t("settings.profile.saved")}</span>}
        {status === "error" && <span className="text-danger">{t("settings.profile.saveError")} {" "}
          <button type="button" onClick={() => void flush()} className="underline">{t("settings.profile.retry")}</button>
        </span>}
      </div>
    </div>
  );
}
