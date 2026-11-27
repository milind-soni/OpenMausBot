/** URLs in the model-facing accessibility snapshot are display hints, not
 * navigation capabilities (actions use refs). Remove the parts most likely
 * to contain OAuth codes, API tokens, signed-query credentials or fragments. */
export function sanitizeSnapshotUrl(raw: string, base?: string): string {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol}//`;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}
