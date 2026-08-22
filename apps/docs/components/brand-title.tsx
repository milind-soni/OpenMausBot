export function BrandTitle() {
  return (
    <span className="flex items-center gap-2.5">
      <img src="/app-icon.svg" alt="" className="size-7 rounded-[7px]" />
      <span className="font-semibold tracking-tight">OpenMausBot</span>
      <span className="rounded-full border border-fd-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-fd-muted-foreground">
        Docs
      </span>
    </span>
  );
}
