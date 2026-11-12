const HISTORY_KEY = "mobile-preview-url-history";
const MAX_HISTORY = 20;

export function getMobilePreviewUrlHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function addMobilePreviewUrlToHistory(url: string): string[] {
  const existing = getMobilePreviewUrlHistory().filter((item) => item !== url);
  const next = [url, ...existing].slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

export function clearMobilePreviewUrlHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {}
}
