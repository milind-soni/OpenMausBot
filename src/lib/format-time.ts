const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function formatTime(at: number) {
  const date = new Date(at);
  // toLocaleTimeString's output, where Intl.DateTimeFormat.format would throw
  return Number.isNaN(date.getTime()) ? "Invalid Date" : TIME_FORMAT.format(date);
}
