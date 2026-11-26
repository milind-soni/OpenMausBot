import type { ReactNode } from "react";

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  timeZone: "Europe/Berlin",
});

export function AgendaDayItem({ date, children }: { date: string; children: ReactNode }) {
  return <section className="flex flex-col gap-2 py-4">
    <h4 className="text-lg font-semibold tracking-tight text-ink">
      <time dateTime={date}>{DAY_FORMAT.format(new Date(`${date}T12:00:00Z`))}</time>
    </h4>
    <div className="flex min-w-0 flex-col gap-2">{children}</div>
  </section>;
}
