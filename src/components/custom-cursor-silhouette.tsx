import React from "react";

import { MASCOT_BODIES } from "../../shared/mascot-bodies";
import {
  customMascotDefinitionOf,
  customMascotDefinitionSchema,
  customMascotOutlinePathData,
  type CustomMascotPoint,
  type CustomMascotShape,
} from "../../shared/mascot-profile";

interface CursorSilhouetteBase {
  name: string;
  anchor: { x: number; y: number; scale: number };
}

export type BuiltinCursorSilhouette = CursorSilhouetteBase & {
  fit: string;
  body: string;
  clip: string;
  outline?: never;
};

export type CustomCursorSilhouette = CursorSilhouetteBase & {
  outline: readonly CustomMascotPoint[];
  fit?: never;
  body?: never;
  clip?: never;
};

export type CursorSilhouette = BuiltinCursorSilhouette | CustomCursorSilhouette;

export function isCustomCursorSilhouette(silhouette: CursorSilhouette): silhouette is CustomCursorSilhouette {
  return "outline" in silhouette;
}

const { id: _cursorBodyId, ...cursorSilhouette } = MASCOT_BODIES.cursor;
export const DEFAULT_SILHOUETTE: CursorSilhouette = cursorSilhouette;

const customSilhouetteCache = new WeakMap<CustomMascotShape, CursorSilhouette | null>();

export function customMascotSilhouette(shape: CustomMascotShape): CursorSilhouette | undefined {
  const cached = customSilhouetteCache.get(shape);
  if (cached !== undefined) return cached ?? undefined;
  const parsed = customMascotDefinitionSchema.safeParse(customMascotDefinitionOf(shape));
  const silhouette = parsed.success && customMascotOutlinePathData(parsed.data.outline)
    ? { name: parsed.data.name, anchor: parsed.data.anchor, outline: parsed.data.outline }
    : null;
  customSilhouetteCache.set(shape, silhouette);
  return silhouette ?? undefined;
}

export function CursorSilhouetteClipPath({ silhouette, id }: { silhouette: CursorSilhouette; id: string }): React.ReactElement {
  if (isCustomCursorSilhouette(silhouette)) {
    return <clipPath id={id}><path d={customMascotOutlinePathData(silhouette.outline)} /></clipPath>;
  }
  return (
    <clipPath
      id={id}
      transform={silhouette.fit || undefined}
      dangerouslySetInnerHTML={{ __html: silhouette.clip }}
    />
  );
}

export function CursorSilhouetteBody({ silhouette, gradientId }: { silhouette: CursorSilhouette; gradientId: string }): React.ReactElement {
  if (isCustomCursorSilhouette(silhouette)) {
    return <path d={customMascotOutlinePathData(silhouette.outline)} fill={`url(#${gradientId})`} />;
  }
  return (
    <g
      transform={silhouette.fit || undefined}
      dangerouslySetInnerHTML={{ __html: silhouette.body.replace(/\{\{GRADIENT\}\}/g, `url(#${gradientId})`) }}
    />
  );
}
