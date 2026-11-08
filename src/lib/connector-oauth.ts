export interface PendingAuthorization {
  url: string;
  createdAt: number;
}

/** Composio authorization links expire after ten minutes; reopening the page must not renew the clock. */
export const AUTHORIZATION_LINK_MS = 10 * 60 * 1_000;

export function reusableConnectionUrl(page: PendingAuthorization | null | undefined, now = Date.now()): string | null {
  return page && now >= page.createdAt && now - page.createdAt < AUTHORIZATION_LINK_MS ? page.url : null;
}

/** Reserve the tab during the click, before an authorization request consumes the browser's user activation. */
export function reserveConnectionPage() {
  const desktop = window.ogb;
  const openExternal = desktop?.openExternal;
  let page: Window | null = null;
  let navigated = false;
  let cancelled = false;
  if (!desktop) {
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
      if (desktop) {
        // A server page inside the desktop app has no openExternal. Its window-open handler
        // refuses a blank tab but sends any web link to the system browser, with no click needed.
        window.open(url, "_blank", "noopener");
        return true;
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
