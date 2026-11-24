import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import type { Bot } from "@/state/store";
import { useStoreDispatch } from "@/state/store-select";
import { SwitchRow } from "./rows";

export function UiInterfaceSetting({ bot }: { bot: Bot }) {
  const dispatch = useStoreDispatch();
  const ownerOrAdmin = useOwnerOrAdmin();
  return (
    <SwitchRow
      title={t("approval.action.enable")}
      color={bot.color}
      checked={bot.uiInterfaceEnabled === true}
      disabled={!ownerOrAdmin && bot.yourAccess !== "edit"}
      onChange={() => dispatch({ type: "updateBot", botId: bot.id, patch: { uiInterfaceEnabled: !bot.uiInterfaceEnabled } })}
    />
  );
}
