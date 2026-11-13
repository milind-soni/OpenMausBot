import { isDeviceSource } from "./previewSource";
import type { PreviewSource } from "./mobilePreviewUrl";

export function scrollSyncSupport(source: PreviewSource | null, desktop: boolean) {
  if (!isDeviceSource(source)) return { supported: false, guidance: "Scroll sync is available only for websites and HTML files." };
  return desktop
    ? { supported: true, guidance: "Matches page scrolling across live previews. Panels inside a page may scroll separately." }
    : { supported: false, guidance: "To sync web pages and HTML files, use the desktop app. In this browser, scroll each preview separately." };
}

export function scrollRatio(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

/** Record the actual applied position, including rounding/clamping. Following a
 * shared ratio must never turn into a fresh source event on the next poll/scroll.
 */
export class ScrollSyncGuard {
  private top = 0;
  applied(top: number) { if (Number.isFinite(top)) this.top = top; }
  observe(top: number, maximum: number): number | null {
    if (!Number.isFinite(top) || !Number.isFinite(maximum)) return null;
    const changed = Math.abs(top - this.top) > 0.5;
    this.top = top;
    return changed && maximum > 0 ? scrollRatio(top / maximum) : null;
  }
}

const readPageScroll = `(() => { const el = document.scrollingElement || document.documentElement; return { top: el.scrollTop, maximum: Math.max(0, el.scrollHeight - el.clientHeight) }; })()`;
interface PageScroll { top: number; maximum: number }
interface ScrollWebview { executeJavaScript(code: string): Promise<unknown> }
function pageScroll(value: unknown): value is PageScroll {
  return !!value && typeof value === "object" && Number.isFinite((value as PageScroll).top) && Number.isFinite((value as PageScroll).maximum);
}

/** Host-side, serialized reads/writes. No guest preload, postMessage listener,
 * Node access or origin change. Poll only while live sync is enabled. Pending
 * writes are coalesced; late results after navigation/unmount are ignored.
 */
export function syncWebviewScroll(view: ScrollWebview, report: (ratio: number) => void, intervalMs = 150) {
  const guard = new ScrollSyncGuard();
  let disposed = false, busy = false, desired: number | null = null;
  const pump = async () => {
    if (disposed || busy) return;
    busy = true;
    const ratio = desired; desired = null;
    let failed = false;
    try {
      const value = await view.executeJavaScript(ratio === null ? readPageScroll : `(() => { const el = document.scrollingElement || document.documentElement; window.scrollTo({ top: Math.max(0, el.scrollHeight - el.clientHeight) * ${JSON.stringify(ratio)}, behavior: 'instant' }); return { top: el.scrollTop, maximum: Math.max(0, el.scrollHeight - el.clientHeight) }; })()`);
      if (disposed || !pageScroll(value)) return;
      if (ratio !== null) guard.applied(value.top);
      else if (desired === null) { const next = guard.observe(value.top, value.maximum); if (next !== null) report(next); }
    } catch {
      // Keep the latest desired position during loading; retry on the timer,
      // rather than spinning or discarding a write before dom-ready.
      failed = true;
      if (ratio !== null && desired === null) desired = ratio;
    }
    finally { busy = false; if (!disposed && !failed && desired !== null) void pump(); }
  };
  const timer = setInterval(() => void pump(), intervalMs);
  void pump();
  return {
    apply(value: number) { const ratio = scrollRatio(value); if (!disposed && ratio !== null) { desired = ratio; void pump(); } },
    close() { disposed = true; desired = null; clearInterval(timer); },
  };
}
