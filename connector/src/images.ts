// The last word on which image the home, or the connector itself, may run, after the protocol's rule (our registry,
// pinned by digest). Images are not signed yet, so that pin is today's whole check; a signature check plugs in here.

import { VERSION_LABEL, olderVersionRefusal } from "./customer-run.ts";
import type { Docker } from "./docker.ts";

/** Throws, in plain words, to refuse `image`; nothing is changed then. `current` is the image running now, if any. */
export type ImageCheck = (image: string, context: { kind: "home" | "connector"; current: string | null }) => Promise<void>;

export const digestPinnedOnly: ImageCheck = async () => {};

/**
 * For a customer-run server: an image that names no released version, or an older one than the image running now, is
 * refused. A connector from before that mode does not know the mode, so going back to one would undo it.
 */
export function neverOlder(docker: Pick<Docker, "imageInspect">): ImageCheck {
  const label = async (image: string | null) => (image ? (await docker.imageInspect(image).catch(() => null))?.Config?.Labels?.[VERSION_LABEL] : undefined);
  return async (image, context) => {
    const refusal = olderVersionRefusal(await label(image), await label(context.current));
    if (refusal) throw new Error(refusal);
  };
}
