/** The fields a native agenda displays. All-day boundaries are ISO calendar dates with an exclusive end. */
export interface DashboardAgendaEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  color?: string;
}

/** One calendar date in the dashboard's time zone. */
export interface DashboardAgendaDay {
  date: string;
  events: DashboardAgendaEvent[];
}

export interface DashboardCalendarChoice {
  id: string;
  name: string;
  primary: boolean;
  color?: string;
}
