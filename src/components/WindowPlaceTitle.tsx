import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { t } from "@/lib/i18n";
import { usePlaceLook } from "@/lib/place-look";
import { placeKindWord, type RailPlace } from "@/lib/places";
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

/** The rail's word for this place, from what this page knows of itself: main's word for it and its own server's config (null
 * until that has loaded). A server anyone may run learns nothing here that it doesn't already know. */
export function windowPlaceKind(place: WorkspaceState, config: { cloudHome?: boolean; team?: unknown } | null | undefined): RailPlace["kind"] | null {
  if (place.local) return "computer";
  if (place.role || config?.team) return "team";
  if (place.home || config?.cloudHome) return "cloud";
  return config ? "server" : null;
}

/** The middle of the window frame's top bar: where the person is, as a tag with the place's mark, its name and its kind. A click
 * opens the list of places on the rail's own page, with the rail hidden or no rail at all; beside an older app, which has no
 * such list, it is a label and part of the bar's drag region. */
export function WindowPlaceTitle() {
  const place = useWindowPlace();
  const look = usePlaceLook();
  const { state } = useStore();
  if (!place) return <span aria-hidden="true" />;
  const name = windowPlaceName(place, state.config?.team?.name);
  const kind = windowPlaceKind(place, state.config);
  const word = kind && placeKindWord(kind, name);
  const said = word ? `${name} · ${word}` : name;
  const openList = window.ogb?.rail?.openList;
  const face = <>
    <PlaceMark place={{ kind: kind ?? "cloud", name, color: look?.color ?? place.color ?? null }} size={16} />
    <span className="min-w-0 truncate">{said}</span>
  </>;
  const tag = "flex h-[22px] min-w-0 max-w-full items-center justify-center gap-1.5 justify-self-center rounded-md bg-ink/[0.06] px-1.5 text-[12px] font-medium text-ink";
  if (!openList) return <div data-window-place className={tag}>{face}</div>;
  return <button type="button" data-window-place aria-haspopup="menu" aria-label={t("rail.tagOpen", { name: said })} title={t("rail.tagOpen", { name: said })}
    onClick={() => void openList().catch(() => {})}
    className={`${tag} transition-colors hover:bg-ink/[0.11] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus`}>
    {face}
    <ChevronDown size={13} strokeWidth={2} aria-hidden="true" className="shrink-0 text-ink-secondary" />
  </button>;
}
