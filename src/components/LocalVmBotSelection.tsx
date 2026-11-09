import type { Bot } from "@/state/store";

import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useStore } from "@/state/store";
import { Card } from "./SettingsPrimitives";

const destinationKeys: Record<NonNullable<Bot["computer"]> | "auto", LocaleKey> = {
  auto: "vm.dest.auto",
  cloud: "place.cloud",
  vm: "vm.dest.vm",
  local: "vm.dest.local",
  browser: "vm.dest.browser",
  off: "vm.dest.off",
};

export function localVmBotComputerPatch(checked: boolean): { computer: "vm" | null } {
  return { computer: checked ? "vm" : null };
}

export function LocalVmBotSelection() {
  const { state, dispatch } = useStore();
  const bots = state.bots.filter((bot) => !bot.hidden);
  if (bots.length === 0) return null;

  return (
    <Card title={t("vm.bots.title")} subtitle={t("vm.bots.subtitle")}>
      <div className="overflow-hidden rounded-xl border border-hairline/40">
        {bots.map((bot, index) => (
          <label
            key={bot.id}
            htmlFor={`local-vm-bot-${bot.id}`}
            className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 ${index > 0 ? "border-t border-hairline/35" : ""}`}
          >
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-ink">{t("vm.bots.use", { name: bot.name })}</span>
              <span className="mt-0.5 block text-[12px] text-ink-secondary">
                {t("vm.bots.current", { destination: t(destinationKeys[bot.computer ?? "auto"]) })}
              </span>
            </span>
            <input
              id={`local-vm-bot-${bot.id}`}
              data-local-vm-bot={bot.id}
              type="checkbox"
              aria-label={t("vm.bots.use", { name: bot.name })}
              className="size-4 shrink-0 accent-accent"
              checked={bot.computer === "vm"}
              onChange={(event) => dispatch({ type: "updateBot", botId: bot.id, patch: localVmBotComputerPatch(event.target.checked) })}
            />
          </label>
        ))}
      </div>
    </Card>
  );
}

