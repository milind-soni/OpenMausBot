type Saved = Awaited<ReturnType<NonNullable<NonNullable<Window["ogb"]>["environments"]>["state"]>>;
/** One place saved on this computer, as Settings reads it. */
export type SavedServer = Saved["environments"][number];

/** A server the person connected by hand: not This computer, My Cloud, another Cloud of theirs or a team's. */
export const byHand = (entry: SavedServer) => entry.kind !== "local" && Boolean(entry.origin) && !entry.home && !entry.cloud && !("team" in entry && entry.team);
