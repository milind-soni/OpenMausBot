import { t } from "./i18n";
import { yourComputerQuestion } from "../../shared/your-computer";
import type { OptionCardData } from "../../shared/wire";

/** The one-time question before a bot uses the person's own computer, in their language; undefined for any other card. */
export function yourComputerAsk(card: Pick<OptionCardData, "yourComputer"> | undefined, name: string): { line: string; detail: string } | undefined {
  if (!card?.yourComputer) return undefined;
  const { key, params } = yourComputerQuestion(card.yourComputer);
  return { line: t(key, params), detail: t("approval.yourComputer.detail", { name }) };
}
