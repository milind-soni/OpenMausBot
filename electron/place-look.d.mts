/** The colour of the place a page shows, as that page sees it: never the Cloud's id. */
export interface PlaceLook {
  name: string;
  color: import("./cloud-buy.mjs").CloudColor | null;
  /** The swatch it is offered as; null for none (or a colour no swatch has). */
  swatch: import("./cloud-list.mjs").CloudSwatch | null;
  /** Where a change goes: the Admin (every app of theirs follows), this app, or nowhere from here. */
  change: "admin" | "local" | null;
  /** Why it can't be changed here: only its Super admin and Admins may, or the MausBot Cloud sign-in is away. */
  reason?: "member" | "signed-out";
}
export type PlaceColorOutcome = "saved" | "refused" | "unsupported" | "failed";
export declare function swatchOf(color: unknown): import("./cloud-list.mjs").CloudSwatch | null;
export declare function listedCloudOf(entry: any, session?: { clouds?: import("./cloud-list.mjs").CloudListEntry[] | null; homeOrigin?: string | null }): import("./cloud-list.mjs").CloudListEntry | null;
export declare function placeLook(entry: any, session?: { clouds?: import("./cloud-list.mjs").CloudListEntry[] | null; homeOrigin?: string | null }): (PlaceLook & { cloudId?: string }) | null;
export declare const SIGNED_IN: string;
export declare function listedLook(cloud: import("./cloud-list.mjs").CloudListEntry | null | undefined): (PlaceLook & { cloudId?: string }) | null;
export declare function railPaint(look: PlaceLook | null, color: unknown): { swatch: import("./cloud-list.mjs").CloudSwatch | null; locked?: "member" | "signed-out" } | null;
export declare function pageLook(look: (PlaceLook & { cloudId?: string }) | null): PlaceLook | null;
export declare function installPlaceLook(deps: {
  ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void };
  guard: (handler: (...args: any[]) => unknown) => (...args: any[]) => unknown;
  place: () => any;
  session: () => { clouds?: import("./cloud-list.mjs").CloudListEntry[] | null; homeOrigin?: string | null };
  setColor: (cloudId: string, swatch: import("./cloud-list.mjs").CloudSwatch | null) => Promise<{ outcome: PlaceColorOutcome }>;
  save: (id: string, color: import("./cloud-buy.mjs").CloudColor | null) => void;
  rail?: { owns(event: unknown): boolean; places(): Array<{ id: string; paint?: unknown }>; saved(id: string): any };
}): { look(): (PlaceLook & { cloudId?: string }) | null };
