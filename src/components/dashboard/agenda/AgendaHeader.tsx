import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { openExternalLink } from "@/lib/app-links";

const MONTH_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
  timeZone: "Europe/Berlin",
});
const UPDATED_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Berlin",
});

export function AgendaHeader({ date, updatedAt }: { date: string; updatedAt: Date | null }) {
  const [externalError, setExternalError] = useState(false);
  const monthDate = new Date(`${date}T12:00:00Z`);
  const openCalendar = () => {
    void openExternalLink("https://calendar.google.com/")
      .then(() => setExternalError(false))
      .catch(() => setExternalError(true));
  };
  return <header className="mb-1">
    <h3 data-agenda-month="" className="text-xl font-semibold tracking-tight text-ink">
      <button type="button" className="inline-flex items-center gap-2 rounded-sm outline-offset-4 hover:underline focus-visible:outline-2" onClick={openCalendar}>
        {MONTH_FORMAT.format(monthDate)}
        <ExternalLink aria-hidden="true" size={16} />
        <span className="sr-only">Open Google Calendar</span>
      </button>
    </h3>
    {updatedAt && <p className="text-sm text-ink-secondary">Updated {UPDATED_FORMAT.format(updatedAt)}</p>}
    {externalError && <p role="status" className="text-sm text-ink-secondary">Couldn’t open Google Calendar.</p>}
  </header>;
}
