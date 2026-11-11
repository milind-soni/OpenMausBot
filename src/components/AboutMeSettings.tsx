import { FIELD_EDGE } from "./SettingsPrimitives";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { saveTeamProfile } from "@/lib/own-profile";
import { createAboutMeDraft } from "./about-me-draft";

const drafts = new WeakMap<object, { controller: ReturnType<typeof createAboutMeDraft>; team: { current: boolean } }>();

export function AboutMeSettings() {
  const { state, dispatch } = useStore();
  const confirmed = state.config?.profile?.aboutMe ?? "";
  const team = Boolean(state.config?.team);
  let draft = drafts.get(dispatch);
  if (!draft) {
    const savesToTeam = { current: team };
    draft = { team: savesToTeam, controller: createAboutMeDraft(confirmed, async (sent) => {
      const profile = savesToTeam.current
        ? await saveTeamProfile({ aboutMe: sent })
        : (await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ profile: { aboutMe: sent } }), timeoutMs: 10_000 })).profile;
      dispatch({ type: "profileSaved", profile: { aboutMe: profile?.aboutMe ?? sent } });
    }) };
    drafts.set(dispatch, draft);
  }
  draft.team.current = team;
  const controller = draft.controller;
  const { value, status } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { flush } = controller;
  useEffect(() => { controller.confirm(confirmed); }, [controller, confirmed]);
  useEffect(() => () => { void flush(); }, [flush]);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="profile-about-me" title={t("settings.profile.aboutMeHelp")} className="text-[13px] font-medium leading-[18px] text-ink">{t("settings.profile.aboutMe")}</label>
      <textarea id="profile-about-me" value={value} rows={5} maxLength={team ? 4_000 : 24_000}
        onChange={(event) => controller.edit(event.target.value)}
        onBlur={() => void flush()}
        placeholder={t("settings.profile.aboutMeHelp")}
        className={`min-h-[96px] w-full resize-none rounded-lg ${FIELD_EDGE} bg-app px-2 py-1.5 text-[13px] leading-5 text-ink placeholder:text-ink-tertiary focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus`}
      />
      <LearnedFacts onChanged={(aboutMe) => { controller.confirm(aboutMe); dispatch({ type: "profileSaved", profile: { aboutMe } }); }} />
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

interface LearnedFact {
  id: string;
  text: string;
  botName: string;
  at: number;
}

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
              className="rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50">
              {t("settings.profile.learned.remove")}
            </button>
          </li>
        ))}
      </ul>
      {error && <div className="mt-2 text-[12px] text-danger">{t("settings.profile.learned.error")}</div>}
    </div>
  );
}
