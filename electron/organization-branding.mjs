/** Optional, cosmetic manifest data. Invalid/old Admin replies keep defaults;
 * they must never interrupt company model access. No remote URLs or SVG. */
export function parseOrganizationBranding(value) {
  const empty = { logo: null, icons: [] };
  if (!value || typeof value !== "object" || JSON.stringify(value).length > 128 * 1024 || !Array.isArray(value.icons) || value.icons.length > 24) return empty;
  const image = (data) => {
    if (typeof data !== "string" || data.length > 96 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
    try {
      const bytes = atob(data.slice(22));
      if (bytes.length < 33 || bytes.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || bytes.slice(12, 16) !== "IHDR") return false;
      const dimension = (offset) => {
        let result = 0;
        for (let index = offset; index < offset + 4; index++) result = result * 256 + bytes.charCodeAt(index);
        return result;
      };
      return dimension(16) > 0 && dimension(16) <= 256 && dimension(20) > 0 && dimension(20) <= 256;
    } catch { return false; }
  };
  if (value.logo !== null && !image(value.logo)) return empty;
  const ids = new Set();
  for (const icon of value.icons) {
    if (!icon || typeof icon.id !== "string" || !/^[0-9a-f-]{36}$/.test(icon.id) || ids.has(icon.id) || typeof icon.name !== "string" || !icon.name.trim() || icon.name.length > 60 || !image(icon.image)) return empty;
    ids.add(icon.id);
  }
  return { logo: value.logo, icons: value.icons.map(({ id, name, image }) => ({ id, name, image })) };
}
