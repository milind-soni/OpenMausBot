export function AppsSection({ id, title, note, viewAll, after, children }: {
  id: string;
  title: string;
  note?: string;
  viewAll?: { label: string; onClick: () => void };
  after?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} data-apps-section={id}>
      <div className="mb-1.5 flex min-h-7 items-center justify-between gap-3 px-2">
        <h3 id={id} className="min-w-0 truncate text-[14px] font-semibold leading-5 text-ink">
          {title}
          {note && <span className="ms-2 text-[12px] font-normal text-ink-secondary">{note}</span>}
        </h3>
        {viewAll && (
          <button
            type="button"
            onClick={viewAll.onClick}
            className="shrink-0 rounded-full px-2 text-[13px] font-medium leading-5 text-ink-secondary transition-colors hover:text-ink"
          >
            {viewAll.label}
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-1 @xl:grid-cols-2">{children}</div>
      {after}
    </section>
  );
}
