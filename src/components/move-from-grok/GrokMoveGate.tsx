import { useEffect, useState } from "react";

import { GrokBotMark } from "@/components/GrokBotMark";
import { GrokMove } from "@/components/lazy-screens";
import { cn } from "@/lib/cn";
import { foundExports, lookForGrokBot, openGrokMove, useGrokMoveRequest } from "@/lib/grok-move";
import { t } from "@/lib/i18n";
import { localSetupImport } from "@/lib/setup-import";

export function GrokMoveGate() {
  const request = useGrokMoveRequest();
  return request ? <GrokMove request={request} /> : null;
}

/** The choice on a welcome screen: one line for everyone, naming a Bot's export already found on this computer. */
export function GrokMoveChoice({ hosted, onMoved, className }: { hosted: boolean; onMoved: (botId: string) => void; className?: string }) {
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    if (!localSetupImport(hosted)) return;
    let live = true;
    void lookForGrokBot(true).then((look) => {
      const first = foundExports(look.files).bots[0];
      if (live && first) setReady(first.name);
    });
    return () => { live = false; };
  }, [hosted]);
  return (
    <button type="button" data-grok-move-open onClick={() => openGrokMove({ onMoved })}
      className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] leading-[18px] text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink", className)}>
      <GrokBotMark size={14} />
      {ready ? t("grokMove.choiceReady", { name: ready }) : t("grokMove.open")}
    </button>
  );
}
