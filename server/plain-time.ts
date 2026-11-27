// When a run happens, as a person says it: "tomorrow (Wednesday, October 28) at 9:00 AM".

function dayKey(at: number, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** From `now`'s day in `zone`: "today at 9:00 AM", "tomorrow (Wednesday, October 28) at 9:00 AM", "Friday, October 30 at 9:00 AM". */
export function plainWhen(at: number, zone: string, now = Date.now()): string {
  try {
    // ICU 72+ puts a narrow no-break space before AM/PM.
    const time = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(at).replace(/\s/g, " ");
    const date = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric" }).format(at);
    const day = dayKey(at, zone);
    const today = dayKey(now, zone);
    if (day === today) return `today at ${time}`;
    if (day === new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) return `tomorrow (${date}) at ${time}`;
    return `${date} at ${time}`;
  } catch {
    return new Date(at).toISOString();
  }
}
