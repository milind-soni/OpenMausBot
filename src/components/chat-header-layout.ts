export function chatHeaderContainer(tiled: boolean, simple: boolean): string {
  if (tiled) return "@container/chathead ps-3 pe-11 py-2";
  return simple
    ? "@container/chathead px-5 pt-2.5 pb-2.5 max-md:pl-14 max-md:pr-3"
    : "@container/chathead px-5 py-3 pl-11 md:pl-5 max-md:pl-14 max-md:pr-3";
}
