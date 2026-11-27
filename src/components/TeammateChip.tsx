// A message a bot passed to a person on a Team Cloud (message_person): the "Told Bob" chip in the conversation that
// asked, with what was passed under it.
import type { Message } from "@/state/store";
import type { TeamPerson } from "@/state/team-people";
import { t } from "@/lib/i18n";
import { PersonFace } from "./TeamOwner";

export function TeammateChip({ message }: { message: Message }) {
  const relay = message.relay;
  if (!relay || relay.kind !== "told") return null;
  const passed = message.tool?.output?.trim();
  return (
    <div className="flex flex-col items-start gap-1" data-relay="told">
      <span className="ui-pill" title={t("relay.toldHint", { name: relay.name })}>
        <PersonFace person={{ email: relay.email, name: relay.name, role: "member" } satisfies TeamPerson} size={16} />
        <span className="max-w-[480px] truncate">{t("relay.told", { name: relay.name })}</span>
      </span>
      {passed && <p className="max-w-[min(38rem,100%)] rounded-xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] whitespace-pre-wrap break-words text-ink-secondary">{passed}</p>}
    </div>
  );
}
