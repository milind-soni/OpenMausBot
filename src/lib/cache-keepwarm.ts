import type { CacheKeepWarmStatus } from "../../shared/wire";
import { intlLocale, t } from "./i18n";
import { formatTokens, formatUsd, hasFiniteCost } from "./usage";

const clock = (at: number) => new Date(at).toLocaleTimeString(intlLocale(), { hour: "numeric", minute: "2-digit" });

export function keepWarmLine(status: CacheKeepWarmStatus | undefined, format: (at: number) => string = clock): string | null {
  if (!status) return null;
  const last = status.last
    ? hasFiniteCost(status.last.costUsd)
      ? t("chat.keepWarm.lastCost", { tokens: formatTokens(status.last.read), cost: formatUsd(status.last.costUsd) })
      : t("chat.keepWarm.last", { tokens: formatTokens(status.last.read) })
    : null;
  if (status.state === "stopped") {
    return [t("chat.keepWarm.stopped", { reason: status.stopped ?? "" }), last].filter(Boolean).join(" · ");
  }
  return [
    t("chat.keepWarm.warm"),
    status.nextPingAt !== undefined ? t("chat.keepWarm.next", { time: format(status.nextPingAt) }) : null,
    last,
    status.until !== undefined ? t("chat.keepWarm.until", { time: format(status.until) }) : null,
  ].filter(Boolean).join(" · ");
}
