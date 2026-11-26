const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** A routine's weekdays as a package carries them, 0-6 from Sunday. Hand-written templates count Sunday as 7, as cron
 * does, or name the days ("mon", "Monday"); both read as 0-6, once each. Anything else is left for the schema to refuse. */
export function readWeekdays(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return [...new Set(value.map((day) => {
    if (day === 7) return 0;
    const name = typeof day === "string" ? day.trim().toLowerCase() : "";
    const index = DAY_NAMES.findIndex((full) => name === full || name === full.slice(0, 3));
    return index === -1 ? day : index;
  }))];
}
