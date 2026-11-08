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
    <div className="flex flex-col gap-2">
      <label htmlFor="profile-every-bot-rules" className="text-[14px] text-ink">{t("settings.profile.everyBotRules")}</label>
      <textarea id="profile-every-bot-rules" value={value} rows={4} maxLength={24_000}
        placeholder={t("settings.profile.everyBotRulesPlaceholder")}
        onChange={(event) => edit(event.target.value)}
        onBlur={() => void flush()}
        className="min-h-[96px] w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
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
