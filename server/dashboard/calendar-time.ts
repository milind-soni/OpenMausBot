export const AGENDA_TIME_ZONE = "Europe/Berlin";

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: AGENDA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const offsetFormat = new Intl.DateTimeFormat("en", {
  timeZone: AGENDA_TIME_ZONE,
  timeZoneName: "longOffset",
});

export function berlinDay(date: Date): string {
  const parts = dayFormat.formatToParts(date);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value;

  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function addAgendaDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);

  return date.toISOString().slice(0, 10);
}

export function berlinMidnight(day: string): string {
  // Berlin's DST transitions occur after 00:00 UTC, so this instant has the local midnight's offset.
  const midnightUtc = new Date(`${day}T00:00:00Z`);
  const zone = offsetFormat
    .formatToParts(midnightUtc)
    .find(({ type }) => type === "timeZoneName")?.value;
  const offset = zone?.replace(/^GMT/, "");
  if (!offset) throw new Error("Berlin offset unavailable");

  return `${day}T00:00:00${offset}`;
}
