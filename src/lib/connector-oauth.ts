export interface PendingAuthorization {
  url: string;
  createdAt: number;
}

/** Composio authorization links expire after ten minutes. A retry must not
 * renew this clock merely because the same page was opened again. */
export function reusableConnectionUrl(page: PendingAuthorization | null | undefined, now = Date.now()): string | null {
  return page && now >= page.createdAt && now - page.createdAt < 10 * 60 * 1_000 ? page.url : null;
}

/** Reserve the tab during the click, before an authorization request can
 * consume the browser's user activation. Only our unused blank is closed. */
export function reserveConnectionPage() {
  const openExternal = window.ogb?.openExternal;
  let page: Window | null = null;
  let navigated = false;
  let cancelled = false;
  if (!openExternal) {
    try {
      page = window.open("", "_blank");
      if (page) page.opener = null;
    } catch {
      page?.close();
      page = null;
    }
  }
  return {
    async open(url: string): Promise<boolean> {
      if (cancelled) return false;
      if (openExternal) {
        await openExternal(url);
        return !cancelled;
      }
      if (!page || page.closed) return false;
      try {
        page.location.replace(url);
        navigated = true;
        return true;
      } catch {
        return false;
      }
    },
    cancel() {
      cancelled = true;
      if (!navigated && page && !page.closed) page.close();
    },
  };
}
