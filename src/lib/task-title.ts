import { SHARED_CHAT_TITLE } from "../../shared/wire";
import { t } from "./i18n";

/** Localize the factory title while preserving titles chosen by the user. */
export function localizedTaskTitle(title: string): string {
  if (title === SHARED_CHAT_TITLE) return t("task.sharedChat");
  return title === "New thread" ? t("task.newShort") : title;
}
