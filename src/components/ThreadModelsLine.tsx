import { useRef, useState } from "react";

import { threadsOnOwnModel } from "../../shared/thread-model";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";

export function ThreadModelsLine({ bot, className }: { bot: Bot; className?: string }) {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(0);
  const latestRequest = useRef(0);
  const count = threadsOnOwnModel(bot.modelSelection, bot.tasks ?? []).length;
  if (count === 0) return null;
  return (
    <div data-thread-models className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-secondary", className)}>
      <span>{count === 1 ? t("model.threadsOwnModelOne") : t("model.threadsOwnModel", { count })}</span>
      <button
        type="button"
        data-switch-them-too
        onClick={() => {
          const request = ++latestRequest.current;
          dispatch({
            type: "followBotModel",
            botId: bot.id,
            onSettled: (result) => {
              if (request === latestRequest.current) setBusy(result.busy);
            },
          });
        }}
        className="-mx-1.5 rounded-lg px-1.5 py-0.5 text-[13px] font-medium text-accent-text hover:bg-control/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {count === 1 ? t("model.switchItToo") : t("model.switchThemToo")}
      </button>
      {busy > 0 && (
        <span data-busy-threads role="status" className="basis-full">
          {busy === 1 ? t("model.busyThreadKeptModelOne") : t("model.busyThreadsKeptModel", { count: busy })}
        </span>
      )}
    </div>
  );
}
