import { useEffect, useState } from "react";

type UseMyComputerBridge = { due?(): Promise<boolean>; ask?(language?: string): Promise<void> };

const RECHECK_MS = 30_000;

/** Whether main says its Use my Mac popup is due on this computer: null until it answers, false without the bridge.
 * Asked again every 30 seconds while it is not, so a Cloud that connects later is seen, until `settled`. */
export function useUseMyComputerDue(bridge: UseMyComputerBridge | undefined, settled: boolean): boolean | null {
  const asks = Boolean(bridge?.due && bridge.ask);
  const [due, setDue] = useState<boolean | null>(null);
  useEffect(() => {
    if (!asks || settled || due === true) return;
    let active = true;
    const check = () => void bridge!.due!().then(next => { if (active) setDue(next === true); }, () => { if (active) setDue(false); });
    check();
    const timer = setInterval(check, RECHECK_MS);
    return () => { active = false; clearInterval(timer); };
  }, [bridge, asks, settled, due]);
  return asks && !settled ? due : false;
}
