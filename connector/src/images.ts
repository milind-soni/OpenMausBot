// The last word on which image the home, or the connector itself, may run, after the protocol's rule (our registry,
// pinned by digest). Images are not signed yet, so that pin is today's whole check; a signature check plugs in here.

/** Throws, in plain words, to refuse `image`; nothing is changed then. `current` is the image running now, if any. */
export type ImageCheck = (image: string, context: { kind: "home" | "connector"; current: string | null }) => Promise<void>;

export const digestPinnedOnly: ImageCheck = async () => {};
