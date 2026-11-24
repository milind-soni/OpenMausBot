/** Changes the page's address without a new history entry, keeping the entry's state (such as the phone back step it marks). */
export function replaceUrl(url: string): void {
  window.history.replaceState(window.history.state ?? null, "", url);
}
