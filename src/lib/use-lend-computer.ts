// The one switch for "Let <server>'s bots use this computer", the same wherever it shows: a server's row in Settings
// (Your computers), its card on the Devices page, the add form, and that server's own Screen panel. All of them read and
// change one state, in this app's main process (electron/server-lending.mjs), through this hook.
import { useCallback, useEffect, useRef, useState } from "react";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";

export type LendView = DesktopLendView;

/** How often an open switch reads the state again: a permission granted in System Settings turns its line off by itself. */
const READ_EVERY_MS = 4000;

/** The line under the switch, or in its place when the server can't be lent to: one plain sentence. */
export function lendLine(view: LendView, app = productName()): string {
  const name = view.name;
  if (!view.lendable) {
    switch (view.why) {
      case "team": return t("lend.why.team", { name });
      case "cloud": return t("lend.why.cloud", { name, app });
      case "shared": return t("lend.why.shared", { name });
      case "not-owner": return t("lend.why.notOwner", { name });
      case "old": return t("lend.why.old", { name });
      case "settings": return t("lend.why.settings", { name });
      default: return t("lend.why.unreachable", { name });
    }
  }
  if (!view.on) return t("lend.off", { app });
  if (view.paused) return t("lend.paused", { app });
  if (view.screen === "permissions") return t("lend.screen.permissions", { app });
  if (view.screen === "starting") return t("lend.screen.starting");
  if (view.screen === "blocked") return t("lend.screen.blocked", { app });
  if (view.screen === "not-running") return t("lend.screen.notRunning", { app });
  if (view.screen === "off") return t("lend.screen.off");
  if (view.screen === "unsupported") return t("lend.screen.unsupported");
  if (!view.connected) return t("lend.connecting", { name });
  return t("lend.on", { name, app });
}

/** `id`: the saved server, on this app's own page; null on a server's own page, where it is that server. `enabled`: false
 * reads nothing (a row that isn't a server saved by hand). */
export function useLendComputer(id: string | null, enabled = true) {
  const bridge = window.ogb?.lendComputer;
  const [view, setView] = useState<LendView | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);
  useEffect(() => {
    if (!bridge || !enabled) { setView(null); return; }
    let alive = true;
    const read = () => void bridge.state(id).then((next) => { if (alive && !busy.current) setView(next); }).catch(() => {});
    read();
    const timer = window.setInterval(read, READ_EVERY_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [bridge, id, enabled]);
  const run = useCallback(async (act: (lend: NonNullable<typeof bridge>) => Promise<LendView>, next: boolean | null) => {
    if (!bridge || busy.current) return;
    busy.current = true; setPending(next); setError("");
    try { setView(await act(bridge)); }
    catch (failure) { setError(String((failure as Error)?.message ?? failure).replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "")); }
    finally { busy.current = false; setPending(null); }
  }, [bridge]);
  return {
    available: Boolean(bridge),
    view,
    /** What the switch shows: the tap at once, then what main says. */
    on: pending ?? (view?.lendable === true && view.on),
    busy: pending !== null,
    error,
    set: (on: boolean) => run((lend) => lend.set(id, on), on),
    allowScreen: () => run((lend) => lend.allowScreen(id), null),
  };
}
