import { DateTimeDisplay } from "./clock/DateTimeDisplay";
import { GoogleCalendarConnection } from "./GoogleCalendarConnection";

const line = "h-2.5 rounded-full bg-ink/[0.1]";

export default function DashboardPage() {
  return (
    <div aria-label="Dashboard" className="relative z-1 grid min-h-dvh w-full grid-cols-1 gap-4 p-4 md:h-dvh md:grid-cols-3 md:grid-rows-[auto_1fr_auto] xl:grid-rows-[auto_1fr_auto]">
      <aside
        aria-label="Calendar agenda"
        className="flex min-h-0 min-w-0 flex-col gap-5 overflow-hidden rounded-2xl border border-hairline/60 bg-card p-5 md:col-start-1 md:row-span-3 md:row-start-1 md:overflow-y-auto md:overscroll-contain"
      >
        <GoogleCalendarConnection />
        <div className="flex flex-col gap-3" aria-hidden="true">
          <div className={`${line} w-2/5`} />
          <div className={`${line} w-1/3`} />
          <div className={`${line} w-1/4`} />
        </div>
        <div className="flex flex-col gap-3 pt-2" aria-hidden="true">
          {["w-full", "w-4/5", "w-11/12", "w-3/4", "w-2/3"].map((width) => (
            <div key={width} className={`${line} ${width}`} />
          ))}
        </div>
      </aside>

      {/* <main className="col-start-1 row-start-4 min-w-0 md:col-start-2 md:row-start-1 md:row-span-2">
        <div className="flex h-full min-w-0 flex-col justify-center">
          <section aria-label="Dashboard content" className="flex min-h-48 flex-col gap-4 rounded-2xl border border-hairline/60 bg-card p-6">
            <div aria-hidden="true" className={`${line} w-1/3`} />
            <div aria-hidden="true" className="flex flex-col gap-3 pt-2">
              <div className={`${line} w-full`} />
              <div className={`${line} w-5/6`} />
            </div>
            <div aria-hidden="true" className="flex flex-col gap-3 pt-2">
              <div className={`${line} w-11/12`} />
              <div className={`${line} w-3/4`} />
            </div>
          </section>
        </div>
      </main> */}

      <div className="col-start-1 row-start-1 flex min-w-0 flex-col items-end gap-3 md:col-start-3 md:row-start-1">
        <DateTimeDisplay />
        {/* <div aria-hidden="true" className="h-9 w-36 rounded-xl bg-ink/[0.08]" /> */}
      </div>

      <aside
        aria-label="Tasks"
        className="flex min-h-32 min-w-0 flex-col justify-center gap-3 md:col-start-3 md:row-start-2 md:overflow-y-auto"
      >
        <div aria-hidden="true" className="h-3 w-1/3 self-end rounded-full bg-ink/[0.1]" />
        <div aria-hidden="true" className="flex min-h-40 flex-col gap-4 rounded-2xl border border-hairline/60 bg-card p-5">
          <div className={`${line} w-2/5`} />
          <div className={`${line} w-full`} />
          <div className={`${line} w-5/6`} />
          <div className={`${line} w-11/12`} />
        </div>
      </aside>

      <div className="col-start-1 row-start-5 grid w-full min-w-0 grid-cols-2 gap-3 md:col-start-2 md:col-span-2 md:row-start-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} aria-hidden="true" className="flex min-h-20 flex-col justify-center gap-3 rounded-2xl border border-hairline/60 bg-card px-4 py-3">
            <div className={`${line} w-3/4`} />
            <div className={`${line} w-1/2 bg-ink/[0.07]`} />
          </div>
        ))}
      </div>
    </div>
  );
}
