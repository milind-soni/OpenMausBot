import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { usePlaceLook } from "@/lib/place-look";
import { useStore } from "@/state/store";
import { PlaceMark } from "./PlacesRail";

type WorkspaceState = Awaited<ReturnType<NonNullable<NonNullable<typeof window.ogb>["workspaces"]>["state"]>>;

/** The place this window shows, as main tells this page: null in a browser, on a remote client, or until main answers. */
export function useWindowPlace(): WorkspaceState | null {
  const [place, setPlace] = useState<WorkspaceState | null>(null);
  useEffect(() => {
    const workspaces = window.ogb?.remoteClient?.active ? undefined : window.ogb?.workspaces;
    if (!workspaces) return;
    let alive = true;
    const read = () => void workspaces.state().then((next) => { if (alive) setPlace(next); }).catch(() => {});
    read();
    const off = workspaces.onChanged?.(read);
    return () => { alive = false; off?.(); };
  }, []);
  return place;
}

/** What the window's top bar calls the place: This computer, My Cloud while it is the window's only home (a team's name
 * on a team's Cloud), else the name it was saved under. */
export function windowPlaceName(place: WorkspaceState, team: string | undefined): string {
  if (place.home) return team || t("cloudSetup.myCloud");
  if (place.local && !place.localPath) return t("rail.thisComputer");
  return place.name;
}

/** The middle of the window frame's top bar: the place on screen, its mark as the rail draws it and its name, quiet. It
 * stays part of the bar's drag region. */
export function WindowPlaceTitle() {
  const place = useWindowPlace();
  const look = usePlaceLook();
  const { state } = useStore();
  if (!place) return <span aria-hidden="true" />;
  const name = windowPlaceName(place, state.config?.team?.name);
  return <div data-window-place className="flex min-w-0 items-center justify-center gap-1.5 px-2 text-[12px] font-medium text-ink-secondary">
    <PlaceMark place={{ kind: place.local ? "computer" : place.role ? "team" : "cloud", name, color: look?.color ?? place.color ?? null }} size={16} />
    <span className="min-w-0 truncate">{name}</span>
  </div>;
}
