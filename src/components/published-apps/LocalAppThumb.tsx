import { useEffect, useRef, useState } from "react";

import type { LocalApp } from "../../../shared/local-apps";
import { fetchLocalAppDocument } from "@/lib/local-apps";
import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";
import { APP_FRAME_SANDBOX } from "../app/app-frame-host";
import { appThemeContext } from "../app/app-host-context";
import { LocalAppMark } from "./LocalAppMark";

const PAGE_WIDTH = 880, PAGE_HEIGHT = 550;
const LOAD_TIMEOUT_MS = 12_000;
/** A page that draws itself with script gets a moment before it is shown. */
const SETTLE_MS = 350;
const KEPT_DOCS = 40;
const docs = new Map<string, Promise<string>>();

function srcdocOf(app: LocalApp): Promise<string> {
  const key = `${app.id}:${app.rev}`;
  let doc = docs.get(key);
  if (!doc) {
    doc = fetchLocalAppDocument(app.id, app.rev).then((answer) => answer.srcdoc);
    doc.catch(() => docs.delete(key));
    docs.set(key, doc);
    while (docs.size > KEPT_DOCS) docs.delete(docs.keys().next().value!);
  }
  return doc;
}

function savesData(): boolean {
  const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true || Boolean(window.matchMedia?.("(prefers-reduced-data: reduce)").matches);
}

/**
 * A card's picture of the app: its own page drawn small, loaded only while the card is on screen. Until then, and
 * whenever it can't be shown (offline, saving data, a page that never loads), the app's mark.
 *
 * Security: the frame has the chat frame's sandbox and the document's own policy, takes no pointer or keyboard, and no
 * host answers it, so the page can't send a message, set context or call anything.
 */
export function LocalAppThumb({ app, bot }: { app: LocalApp; bot?: Bot }) {
  const box = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  const [scale, setScale] = useState(0.2);
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const allowed = !savesData();

  useEffect(() => {
    const element = box.current;
    if (!element || !allowed) return;
    const size = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => setScale(element.clientWidth / PAGE_WIDTH));
    size?.observe(element);
    setScale(element.clientWidth / PAGE_WIDTH || 0.2);
    if (typeof IntersectionObserver === "undefined") return () => size?.disconnect();
    const watch = new IntersectionObserver((entries) => {
      const visible = entries.at(-1)?.isIntersecting === true;
      setOnScreen(visible);
      if (!visible) setShown(false);
    }, { rootMargin: "300px" });
    watch.observe(element);
    return () => { size?.disconnect(); watch.disconnect(); };
  }, [allowed]);

  useEffect(() => {
    if (!onScreen || gaveUp) return;
    let live = true;
    srcdocOf(app).then((doc) => { if (live) setSrcdoc(doc); }, () => { if (live) setGaveUp(true); });
    return () => { live = false; };
  }, [onScreen, gaveUp, app]);

  const framed = onScreen && !gaveUp && srcdoc !== null;
  useEffect(() => {
    if (!framed || shown) return;
    const timer = setTimeout(() => setGaveUp(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [framed, shown]);

  return (
    <div ref={box} data-local-app-thumb={framed && shown ? "live" : "mark"} className="relative aspect-[16/10] w-full overflow-hidden bg-inset">
      <div aria-hidden="true" className={cn("absolute inset-0 flex items-center justify-center", framed && shown && "invisible")}>
        <LocalAppMark app={app} bot={bot} size="lg" />
      </div>
      {framed && (
        <iframe
          srcDoc={srcdoc}
          title=""
          aria-hidden="true"
          tabIndex={-1}
          sandbox={APP_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          onLoad={() => setTimeout(() => setShown(true), SETTLE_MS)}
          style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT, transform: `scale(${scale})`, transformOrigin: "0 0", colorScheme: appThemeContext().theme }}
          className={cn("pointer-events-none absolute left-0 top-0 select-none border-0 transition-opacity duration-200 motion-reduce:transition-none",
            shown ? "opacity-100" : "opacity-0")}
          inert
        />
      )}
    </div>
  );
}
