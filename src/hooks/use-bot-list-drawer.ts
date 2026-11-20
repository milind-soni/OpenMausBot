import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";

import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";

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
  const phone = useMediaQuery(PHONE_LAYOUT);
  const [open, setOpen] = useState(phone);
  const home = useRef(phone);
  const acted = useRef(false);
  const show = useCallback(() => { home.current = false; acted.current = false; setOpen(true); }, []);
  const hide = useCallback(() => { home.current = false; setOpen(false); }, []);
  const noteAction = useCallback((event: SyntheticEvent) => {
    if (!(event.target instanceof Element && event.target.closest(KEEPS_LIST_OPEN))) acted.current = true;
  }, []);
  useEffect(() => {
    if (!home.current || acted.current || place.view !== "chat" || place.pluginsOpen || place.settingsOpen) hide();
  }, [hide, place.selectedId, place.view, place.pluginsOpen, place.settingsOpen]);
  useEffect(() => {
    if (!phone) hide();
  }, [phone, hide]);
  useEffect(() => {
    if (acted.current) setOpen(false);
  }, [place.botThread, place.groupThread]);
  return { open, show, hide, noteAction };
}
