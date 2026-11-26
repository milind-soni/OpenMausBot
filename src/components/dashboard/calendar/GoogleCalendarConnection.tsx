import { useEffect, useState } from "react";

import { appCatalogMemory } from "@/lib/app-catalog-cache";
import { preloadConnectedApps, connectorStatusMemory } from "@/lib/connected-apps";
import { hasActiveConnection } from "@/lib/connector-status";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { AppTileView, type AppTileActions } from "../../AppTile";
import type { ToolkitCard } from "../../ServiceIcon";

const FALLBACK_CARD: ToolkitCard = {
  slug: "googlecalendar",
  label: "Google Calendar",
  blurb: "",
  logo: null,
  domain: "calendar.google.com",
};

function initialConnectionState(): boolean | null {
  const inventory = connectorStatusMemory();
  return inventory?.authoritative ? hasActiveConnection(inventory.services.googlecalendar) : null;
}

export function GoogleCalendarConnection() {
  const dispatch = useStoreDispatch();
  const pluginsOpen = useStoreSelector((state) => state.pluginsOpen);
  const [connected, setConnected] = useState(initialConnectionState);

  useEffect(() => {
    if (pluginsOpen) return;
    let current = true;
    void preloadConnectedApps(true).then(({ services, authoritative, refused }) => {
      if (current) setConnected(authoritative && !refused ? hasActiveConnection(services.googlecalendar) : null);
    });
    return () => {
      current = false;
    };
  }, [pluginsOpen]);

  if (connected !== false) return null;

  const card = appCatalogMemory()?.cards.find((item) => item.slug === "googlecalendar") ?? FALLBACK_CARD;
  const openApps = () => dispatch({ type: "togglePlugins", open: true, surface: "apps" });
  const doNothing = () => undefined;
  const actions: AppTileActions = {
    connect: openApps,
    openUrl: openApps,
    toggleAlias: openApps,
    setAliasDraft: doNothing,
    aliasRequired: doNothing,
    changeBots: doNothing,
    disconnect: doNothing,
    openBotApps: doNothing,
  };

  return (
    <div data-dashboard-connect="googlecalendar">
      <AppTileView
        card={card}
        serviceStatus={{ connected: false }}
        pendingUrl={undefined}
        aliasDraft={null}
        busy={false}
        configured
        inventoryPhase="ready"
        mode={appCatalogMemory()?.mode ?? "managed"}
        policy={undefined}
        usedBy={[]}
        limited={[]}
        canChangeBots={false}
        actions={actions}
      />
    </div>
  );
}
