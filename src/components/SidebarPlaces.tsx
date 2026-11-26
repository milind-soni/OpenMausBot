// The one list's two parts in the sidebar, while "This computer and My Cloud together" is on and the other place has rows
// or a line to show (src/lib/place-rows.ts placeParts): each place under the sidebar's own section heading naming it, the
// person's home place first and the other second, the same on both pages. This page's own part is its sections as ever;
// the other place's part is its rows, in the order that place gave them, or its one line. A heading folds its part like
// any section's heading, and is never dragged: the order of the places is fixed. Otherwise the sidebar is as it was.
import { Fragment, type ReactNode } from "react";
import { sidebarSectionAttention } from "@/lib/sidebar-attention";
import type { SidebarDensityMode } from "@/lib/sidebar-layout";
import { placeHeading, placeParts, useOneListHere, useOneListHome, type PlacedBot, type PlacePart } from "@/lib/place-rows";
import type { Bot } from "@/state/store";
import { OtherPlaceLine, useOtherPlaceSaid } from "./OtherPlaceBots";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { SidebarRailSeparator } from "./SidebarSimpleRail";

/** The parts to draw, or null while the sidebar shows this page's own list alone. `query` is the sidebar's search. */
export function usePlaceParts(placed: readonly PlacedBot[], query: string): readonly [PlacePart, PlacePart] | null {
  const here = useOneListHere(), home = useOneListHome(), said = useOtherPlaceSaid();
  return placeParts(here, home, placed.length > 0 || (said !== null && !query.trim()));
}

/** A part's heading folds it as a section's does; its key is the place's, so each place keeps its own. */
export const placeSectionId = (part: PlacePart): string => `place:${part.home}`;

export function SidebarPlaces({ parts, placed, own, row, query, density, simple, rail, interactive, collapsed, toggle, children }: {
  parts: readonly [PlacePart, PlacePart] | null;
  placed: readonly PlacedBot[];
  /** This page's own bots shown in the list: what a folded heading of its part counts. */
  own: readonly Bot[];
  row: (bot: PlacedBot) => ReactNode;
  query: string;
  density: SidebarDensityMode;
  simple: boolean;
  rail: boolean;
  interactive: boolean;
  collapsed: (id: string) => boolean;
  toggle: (id: string) => void;
  /** This page's own sections. */
  children: ReactNode;
}) {
  // This page's own sections are one keyed part whether the headings show or not, so the other place's first answer, or
  // its last row going, draws a heading and never draws this page's rows again.
  const ownPart = <Fragment key="own">{children}</Fragment>;
  if (!parts) return <>{[ownPart]}</>;
  const icons = density === "icons";
  return <>{parts.flatMap((part, index) => {
    const id = placeSectionId(part), folded = !icons && collapsed(id);
    const heading = icons ? rail && index > 0 ? <SidebarRailSeparator key={`head:${id}`} /> : null
      : <div key={`head:${id}`} data-sidebar-place-heading={part.home} className={index > 0 && !simple ? "pt-3" : undefined}>
        <SidebarSectionHeader name={placeHeading(part.home)} line={simple} reserveMenu={simple} collapsed={folded} reorderable={false} dragging={false}
          onToggle={interactive ? () => toggle(id) : undefined}
          attention={folded ? sidebarSectionAttention(part.own ? [...own] : [...placed], []) : undefined} />
      </div>;
    if (folded) return [heading];
    return [heading, part.own ? ownPart : <div key="placed" data-sidebar-place={part.home} className="contents">{placed.map(row)}<OtherPlaceLine query={query} icons={icons} /></div>];
  })}</>;
}
