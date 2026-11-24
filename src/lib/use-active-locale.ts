import { useSyncExternalStore } from "react";
import { activeLocale, subscribeLocale } from "./i18n";

/** The language t() shows: a memoised component that reads it draws again in a new language, as App does. */
export function useActiveLocale(): string {
  return useSyncExternalStore(subscribeLocale, activeLocale, activeLocale);
}
