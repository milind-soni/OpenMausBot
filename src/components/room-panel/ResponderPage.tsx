import { defaultResponderName, effectiveDefaultResponder, jevRoomRoutingOn } from "@/lib/group-routing";
import { t } from "@/lib/i18n";
import { normalizeState } from "@/lib/mascot";
import { chosenResponder, responderChoice, type ResponderChoice } from "@/lib/room-responder";
import { useStore, type Bot, type Group } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { Card, RadioRow } from "../bot-panel/rows";

export function ResponderPage({ group, members }: { group: Group; members: Bot[] }) {
  const { state, dispatch } = useStore();
  const jevOn = jevRoomRoutingOn(state.config);
  const responder = effectiveDefaultResponder(group, members);
  const current = responderChoice(responder);
  const choose = (choice: ResponderChoice) => {
    if (choice === current) return;
    dispatch({ type: "patchGroup", groupId: group.id, patch: { defaultResponder: chosenResponder(choice, responder) } });
  };
  const behaviours: { choice: ResponderChoice; title: string; hint?: string }[] = [
    {
      choice: "auto",
      title: t("room.panel.responder.autoOption"),
      hint: jevOn ? undefined : t("room.responder.autoOff", { name: defaultResponderName(group, members) ?? t("room.responder.leadFallback") }),
    },
    { choice: "everyone", title: t("room.panel.responder.everyone") },
    { choice: "mentions", title: t("room.panel.responder.mentions") },
  ];
  return (
    <div role="radiogroup" aria-label={t("room.panel.whoResponds")}>
      <Card>
        {members.map((member) => (
          <RadioRow
            key={member.id}
            data-panel-choice={`member:${member.id}`}
            title={
              <span className="flex min-w-0 items-center gap-2.5">
                <BotAvatar bot={member} state={normalizeState(member.mascotExpression) ?? "happy"} size={22} animated={false} />
                <span className="truncate">{member.name}</span>
              </span>
            }
            checked={current === `member:${member.id}`}
            onClick={() => choose(`member:${member.id}`)}
          />
        ))}
        {behaviours.map(({ choice, title, hint }) => (
          <RadioRow
            key={choice}
            data-panel-choice={choice}
            title={title}
            hint={hint}
            checked={current === choice}
            onClick={() => choose(choice)}
          />
        ))}
      </Card>
    </div>
  );
}
