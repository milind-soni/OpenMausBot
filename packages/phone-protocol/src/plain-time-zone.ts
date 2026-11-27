/** Zones whose generic name reads oddly in a sentence ("United Kingdom Time"), said the way people say them. */
const SAID: Record<string, string> = {
  "Europe/London": "UK time", "Europe/Belfast": "UK time", "America/Phoenix": "Arizona time", "Asia/Dubai": "UAE time",
};
const UNIVERSAL = /^(?:Etc\/)?(?:UTC|UCT|GMT|Universal|Zulu|Greenwich)(?:[+-]0)?$/i;
const ABBREVIATION = /^(?:[A-Z]{1,5}|GMT.*|UTC.*)$/;

function zoneName(zone: string, locale: string, style: "shortGeneric" | "longGeneric"): string | null {
  try {
    const name = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style })
      .formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value;
    return name && !ABBREVIATION.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** A time zone as a person says it: "India time", "Pacific time", "Germany time", "UTC". Never the IANA id
 * ("Asia/Calcutta"), an abbreviation ("PT") or an offset ("GMT+5:30"). */
export function plainTimeZone(zone: string, locale = "en"): string {
  const english = locale.toLowerCase().startsWith("en");
  if (UNIVERSAL.test(zone.trim())) return "UTC";
  if (english && SAID[zone]) return SAID[zone]!;
  const name = zoneName(zone, locale, "shortGeneric") ?? zoneName(zone, locale, "longGeneric");
  if (name) return english ? name.replace(/ Time$/, " time") : name;
  const city = zone.split("/").at(-1)?.replaceAll("_", " ").trim();
  return city ? `${city} time` : zone;
}

/** "09:00" as people write it: "9:00". */
export const plainClock = (time: string) => time.replace(/^0(\d):/, "$1:");

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Local weekdays (Sunday = 0) as people say them: "every day", "weekdays", "Monday, Wednesday". */
export function plainWeekdays(weekdays: readonly number[]): string {
  // One day each, in weekday order: a schedule stores its weekdays in whatever order it was built in, so a
  // shuffled list read back in that order names its two days the wrong way round, and a repeated one twice.
  const days = [...new Set(weekdays)].sort((a, b) => a - b);
  const joined = days.join(",");
  return joined === "0,1,2,3,4,5,6" ? "every day" : joined === "1,2,3,4,5" ? "weekdays" : days.map((day) => WEEKDAYS[day]).join(", ");
}
