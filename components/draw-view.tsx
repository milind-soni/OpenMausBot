"use client";
import { ContentSkeleton } from "./content-skeleton";

import { lazyComponent } from "./lazy-component";
import type { Id } from "@/convex/_generated/dataModel";
// Client only (it loads after mount); a chunk that cannot be fetched shows Reload here instead of failing the app.
const Canvas = lazyComponent(() => {
  (window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw/";
  return import("./drawing-canvas").then(module => module.default);
}, <ContentSkeleton kind="canvas" label="Loading drawing" />);

export function DrawView({ sessionToken, user, canvasId, readOnly, name }: { sessionToken: string; user: { _id: string; name: string }; canvasId?: Id<"canvases">; readOnly?: boolean; name?: string }) {
  return <section className="draw-view" aria-label="Draw"><Canvas key={canvasId || "workspace"} sessionToken={sessionToken} user={user} canvasId={canvasId} readOnly={readOnly} name={name} /></section>;
}
