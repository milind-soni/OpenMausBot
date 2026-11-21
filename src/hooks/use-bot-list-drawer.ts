import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";

export interface DrawerPlace {
  selectedId: string;
  botThread: string | undefined;
  groupThread: string | undefined;
  view: string;
  pluginsOpen: boolean;
  settingsOpen: boolean;
}

const KEEPS_LIST_OPEN = "[data-team-side]";

/**
 * The bot list that covers a narrow window. It closes when the person goes somewhere: another chat or page, or a
 * conversation they picked while it was open. A conversation that changes under it by itself (the one the app settles on
 * as it starts, a switch made on another device) leaves it open.
 */
export function useBotListDrawer(place: DrawerPlace) {
  const [open, setOpen] = useState(false);
  const acted = useRef(false);
  const show = useCallback(() => { acted.current = false; setOpen(true); }, []);
  const hide = useCallback(() => setOpen(false), []);
  const noteAction = useCallback((event: SyntheticEvent) => {
    if (!(event.target instanceof Element && event.target.closest(KEEPS_LIST_OPEN))) acted.current = true;
  }, []);
  useEffect(() => {
    setOpen(false);
  }, [place.selectedId, place.view, place.pluginsOpen, place.settingsOpen]);
  useEffect(() => {
    if (acted.current) setOpen(false);
  }, [place.botThread, place.groupThread]);
  return { open, show, hide, noteAction };
}
