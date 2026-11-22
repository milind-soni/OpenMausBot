import { lazy, Suspense, type ComponentProps } from "react";

// The dialog reads the public-suffix list (shared/logins), which the launch bundle leaves out: it loads on first open.
const Dialog = lazy(() => import("./CookieImportDialog").then((module) => ({ default: module.CookieImportDialog })));

/** The site a page address belongs to, for the form to start from; empty for anything but a web page. */
export function siteOfAddress(address: string): string {
  try {
    const url = new URL(address);
    return url.protocol === "https:" || url.protocol === "http:" ? url.hostname.replace(/^www\./u, "") : "";
  } catch {
    return "";
  }
}

/** Whether this app can import a sign-in for a bot here: the desktop app, with the server's import ready. */
export function cookieImportAvailable(config: { browserEngine?: { cookieImport?: true } } | null | undefined): boolean {
  return config?.browserEngine?.cookieImport === true && Boolean(window.ogb?.browserCookies);
}

/** The sign-in import dialog, loaded the first time it opens. */
export function CookieImportDialog(props: ComponentProps<typeof Dialog>) {
  if (!props.open) return null;
  return <Suspense fallback={null}><Dialog {...props} /></Suspense>;
}
