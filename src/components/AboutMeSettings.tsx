import { useEffect, useState, useSyncExternalStore } from "react";
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
      <LearnedFacts onChanged={(aboutMe) => { controller.confirm(aboutMe); dispatch({ type: "profileSaved", profile: { aboutMe } }); }} />
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

interface LearnedFact {
  id: string;
  text: string;
  botName: string;
  at: number;
}

/** What bots with Memory upkeep added to About me on their own, newest
 * first, each with Remove: About me reaches every bot, so the person can
 * always see and take back what was added for them. */
function LearnedFacts({ onChanged }: { onChanged: (aboutMe: string) => void }) {
  const [facts, setFacts] = useState<LearnedFact[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ learned: LearnedFact[] }>("/api/profile/learned")
      .then((result) => { if (!cancelled) setFacts(result.learned); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const remove = async (id: string) => {
    setBusy(id);
    setError(false);
    try {
      const result = await api<{ aboutMe: string; learned: LearnedFact[] }>(`/api/profile/learned/${encodeURIComponent(id)}/remove`, { method: "POST" });
      setFacts(result.learned);
      onChanged(result.aboutMe);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  };

  if (!facts.length) return null;
  return (
    <div className="mt-1 rounded-lg border border-hairline/40 bg-inset p-3">
      <div className="text-[13px] font-medium text-ink">{t("settings.profile.learned.title")}</div>
      <p className="mt-0.5 text-[12px] text-ink-secondary">{t("settings.profile.learned.hint")}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {facts.map((fact) => (
          <li key={fact.id} className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
            <span className="min-w-0 flex-1">
              {fact.text}{" "}
              <span className="text-[12px] text-ink-secondary">{t("settings.profile.learned.from", { name: fact.botName })}</span>
            </span>
            <button type="button" disabled={busy === fact.id} onClick={() => void remove(fact.id)}
              className="rounded-md px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50">
              {t("settings.profile.learned.remove")}
            </button>
          </li>
        ))}
      </ul>
      {error && <div className="mt-2 text-[12px] text-danger">{t("settings.profile.learned.error")}</div>}
    </div>
  );
}
