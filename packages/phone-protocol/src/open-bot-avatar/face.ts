/**
 * MausBot: per-body face styling the stock engine lacks, keyed by definition id: an eye shape,
 * a band or face window behind the eyes, colour regions drawn on the face (traced faces), and
 * no mouth. A body without an entry draws exactly as before.
 */
export interface Face {
  /**
   * Fixed colours for body parts by index (outline subpaths in path order); the rest take the
   * body colour. A face set into a hood is a hole in the hood filled by its own part.
   */
  parts?: Record<number, string>;
  /** Eye colour when the host sets none. */
  ink?: string;
  /** Eye size in viewBox units, in place of the ew/eh multipliers. */
  eyeW?: number;
  eyeH?: number;
  /** Rest facing straight ahead instead of the engine's slight turn (a front-view drawing). */
  front?: boolean;
  /** false hides our smile. */
  mouth?: boolean;
  /** angry: slanted lens, mirrored; round: oval dots; wink: left dot, right slanted dash; none: no engine eyes (the face is in the outline or the marks). */
  eye?: 'angry' | 'round' | 'wink' | 'none';
  /** Eye size multipliers on the stock pill (width, height). */
  ew?: number;
  eh?: number;
  /** Colour regions drawn on the face plane, in order (viewBox units). */
  marks?: { d: string; color: string }[];
  /** A band or face window behind the eyes (viewBox units). */
  band?: { x: number; y: number; w: number; h: number; r?: number; color: string };
}

export const FACES = new Map<string, Face>();
