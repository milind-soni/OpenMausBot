import { useState } from "react";

import { botOwner } from "../../../shared/bot-owner";
import { t } from "@/lib/i18n";
import { api, type Bot } from "@/state/store";
import { useTeamPeople } from "@/state/team-people";

type Asked = Array<{ email: string; name: string }>;

/** "Ask Ada to chat" for a team bot this person can only view: its owner gets an Allow / Not now card in their inbox (the
 * admins, when nobody on the team owns it), and Allow lets this person chat at once. */
export function AskToChat({ bot }: { bot: Pick<Bot, "id" | "createdBy" | "reportsTo" | "defaultBot"> }) {
  const team = useTeamPeople();
  const [asked, setAsked] = useState<Asked | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!team) return null;
  const ownerEmail = botOwner(bot);
  const owner = team.people.find((person) => person.email === ownerEmail);
  const whom = (people: Asked) => (people.length === 1 ? people[0]!.name : t("botAccess.theAdmins"));
  if (asked) return <span role="status" data-ask-to-chat="asked" className="shrink-0 text-[13px] text-ink-secondary">{t("botAccess.asked", { name: whom(asked) })}</span>;
  const ask = async () => {
    setBusy(true);
    setError("");
    try {
      const answer = await api<{ asked?: Asked }>(`/api/bots/${bot.id}/access-request`, { method: "POST", body: "{}" });
      setAsked(answer.asked ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {error && <span role="alert" className="min-w-0 text-[12px] text-danger">{error}</span>}
      <button type="button" data-ask-to-chat disabled={busy} onClick={() => void ask()}
        className="shrink-0 rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-60">
        {owner ? t("botAccess.ask", { name: owner.name }) : t("botAccess.askAdmins")}
      </button>
    </>
  );
}
