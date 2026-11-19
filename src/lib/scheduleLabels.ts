export function zoneLabel(timeZone: string) {
  try {
    const short = new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: "short" }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value;
    const city = timeZone.split("/").pop()?.replace(/_/g, " ") ?? timeZone;
    return short && short !== city ? `${city} (${short})` : city;
  } catch {
    return timeZone;
  }
}

export function relativeTime(at: string, now = Date.now()) {
  const minutes = Math.round((new Date(at).getTime() - now) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes <= 0) return "due now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}
