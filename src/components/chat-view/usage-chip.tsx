import {
  cachedInput,
  cachedKnown,
  contextChip,
  contextDetail,
  contextShare,
  costCaption,
  formatTokens,
  formatUsd,
  freshTokens,
  hasFiniteCost,
  lastTurnDetail,
  usageChip,
  usageDetail,
} from "@/lib/usage";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
/** What the open task has spent — quiet until the first turn settles.
 * Click opens the bot's settings, where the Usage card has the breakdown. */
export function UsageChip({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const usage = bot.tasks?.find((t) => t.threadId === bot.threadId)?.usage;
  const text = usage ? usageChip(usage) : "";
  if (!usage || !text) return null;
  const billing = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.snapshot.billing;
  const share = contextShare(usage);
  const detail = [
    usage.turns === 1 ? t("chat.usage.turnsOne") : t("chat.usage.turnsMany", { count: usage.turns }),
    usageDetail(usage),
    lastTurnDetail(usage),
    contextDetail(usage),
    // the whole thread rides along on every turn, so most of "in" is the
    // model re-reading what it already saw — say so, or the figure reads as
    // a bug (issue #527); past 80% of the window the fix is a new thread
    share?.tone === "danger" ? t("chat.usage.contextNudge") : null,
    cachedInput(usage) > 0 ? (cachedKnown(usage) ? t("chat.usage.newNote") : t("chat.usage.cachedNote")) : null,
    hasFiniteCost(usage.costUsd) ? `${formatUsd(usage.costUsd)} ${costCaption(billing)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  // folded: one figure — cost when the engine reports one, else new tokens
  const short = hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : formatTokens(cachedKnown(usage) ? freshTokens(usage) : usage.input + usage.output);
  const ctx = contextChip(usage);
  return (
    <button
      onClick={() => dispatch({ type: "openOverlay", kind: "settings", open: true, section: "usage" })}
      className="whitespace-nowrap rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[12px] tabular-nums text-ink-secondary hover:bg-raised hover:text-ink @max-4xl/chathead:px-2"
      title={detail}
      data-testid="usage-chip"
    >
      <span className="@max-4xl/chathead:hidden">{text}</span>
      <span className="hidden @max-4xl/chathead:inline">{short}</span>
      {ctx && <span className={cn("ml-1.5 @max-4xl/chathead:hidden", share?.tone === "danger" ? "text-danger" : share?.tone === "warning" ? "text-warning" : "")} data-testid="usage-context">{ctx}</span>}
    </button>
  );
}
