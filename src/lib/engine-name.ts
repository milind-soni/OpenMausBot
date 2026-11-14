import { en, type LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";

const DEFAULT_NAME_KEY: Readonly<Record<string, LocaleKey>> = {
  claudeApi: "engines.defaultName.claudeApi",
  chatgpt: "engines.defaultName.chatgpt",
  openaiCompat: "engines.defaultName.openaiCompat",
};

export function engineDisplayName(instance: { instanceId: string; displayName: string }): string {
  const key = Object.hasOwn(DEFAULT_NAME_KEY, instance.instanceId) ? DEFAULT_NAME_KEY[instance.instanceId] : undefined;
  return key && instance.displayName === en[key] ? t(key) : instance.displayName;
}
