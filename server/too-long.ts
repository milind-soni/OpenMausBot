// What a bot hears when a call is refused for length: which field, the limit, that nothing happened, and how to send it
// again. Without the last part a bot retries the same words or gives up.

type Issue = { code: string; path: readonly PropertyKey[]; maximum?: number | bigint };

export const tooLongRefusal = (field: string, max: number | bigint, how: string): string =>
  `${field} is over its ${String(max)}-character limit, so nothing was done. ${how}`;

const COORDINATE_FIELDS: Readonly<Record<string, string>> = {
  message: "Send only what the teammate needs to start, and save the long detail to a file in this folder and name its path, then call coordinate_bots again.",
  done_when: "Say in a sentence or two what finished looks like, then call coordinate_bots again.",
  title: "Use a shorter title, then call coordinate_bots again.",
  reason: "Say why in one short line, then call coordinate_bots again.",
};

/** The first over-long field a coordinate_bots call was refused for; undefined when something else was wrong with it. */
export function coordinateTooLong(issues: readonly Issue[]): string | undefined {
  for (const issue of issues) {
    const field = String(issue.path[0]);
    const how = COORDINATE_FIELDS[field];
    if (issue.code === "too_big" && how && issue.maximum !== undefined) return tooLongRefusal(field, issue.maximum, how);
  }
  return undefined;
}
