/** A visual label only; file routing and authorization still use the source path. */
export function FileExtensionBadge({ filename }: { filename: string }) {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(filename)?.[1].toUpperCase();
  if (!extension) return null;
  return <span aria-hidden="true" className="pointer-events-none absolute left-2 top-2 z-10 rounded border border-white/20 bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold leading-4 tracking-wide text-white shadow-sm backdrop-blur-sm">{extension}</span>;
}
