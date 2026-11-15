import { useEffect, useState } from "react";

import type { Action } from "@/state/store";
import { takeConnectRequest } from "./connect-link";
import { useOwnerOrAdmin } from "./use-owner-or-admin";

/** Opens the page a `/?connect=` link asks for, once, and leaves the address clean. A page only a team's admin is
 * shown opens when this person is known to be one, and never for anyone else. */
export function useConnectLink(dispatch: (action: Action) => void, team: boolean): void {
  const admin = useOwnerOrAdmin();
  const [adminSection, setAdminSection] = useState<"botAccess" | null>(null);
  useEffect(() => {
    const request = takeConnectRequest(window.location.href);
    if (!request) return;
    window.history.replaceState(null, "", request.rest);
    if ("teamAdminSection" in request) setAdminSection(request.teamAdminSection);
    else dispatch("section" in request ? { type: "toggleAppSettings", open: true, section: request.section } : { type: "togglePlugins", open: true, surface: request.surface });
  }, [dispatch]);
  useEffect(() => {
    if (!adminSection || !team || admin !== true) return;
    setAdminSection(null);
    dispatch({ type: "toggleAppSettings", open: true, section: adminSection });
  }, [adminSection, team, admin, dispatch]);
}
