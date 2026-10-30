import { useCallback, useEffect, useRef, useState } from "react";
import { LocalizedPanelError } from "@/lib/computer-messages";
import { productName } from "@/lib/brand";

export interface TakeoverSnapshot {
  held: boolean;
  /** This view's lease holds the computer; absent from a plain take or release. */
  owned?: boolean;
}

/** Another device's hand-back and this view's next take can arrive out of order; only a release that lasts ends a session. */
const RELEASE_SETTLE_MS = 1_500;
/** Past a sleeping Boat's wake (90 s) and its desktop link (bounded per request on the server). */
const JOIN_TIMEOUT_MS = 200_000;

/** `crypto.randomUUID` exists only in secure contexts, and a phone may reach the app over plain LAN http. */
const newLeaseId = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (byte) => byte.toString(16).padStart(2, "0")).join("");

type Request = (action: "take" | "release", controlLeaseId?: string) => Promise<TakeoverSnapshot>;

function releaseWhenClosed(tab: Window, release: () => void): void {
  const watch = window.setInterval(() => {
    if (!tab.closed) return;
    window.clearInterval(watch);
    release();
  }, 1_000);
}

/** A provider-hosted desktop (a Boat) ships its own viewer, so it opens in the app's viewer window or its own tab. A
 * stuck join gives the computer back instead of leaving the bot waiting. */
export async function openProviderDesktop({ botId, title, held, request, join, current }: {
  botId: string;
  title: string;
  held: boolean;
  request: Request;
  join: (signal: AbortSignal) => Promise<{ joinUrl?: unknown }>;
  /** Still the conversation and computer the person asked for. */
  current: () => boolean;
}): Promise<void> {
  let lease: string | null = null;
  // Plain web opens its blank tab synchronously, inside the user gesture; the packaged app uses the Electron viewer window.
  let fallbackTab: Window | null = null;
  if (!window.ogb?.desktopViewer && !window.ogb?.openExternal) {
    fallbackTab = window.open("", "_blank");
    if (fallbackTab) fallbackTab.opener = null;
  }
  const changed = () => new DOMException("The selected conversation changed", "AbortError");
  try {
    if (!held) {
      lease = newLeaseId();
      if (!(await request("take", lease)).held) throw new Error(`${productName()} could not confirm computer control`);
    }
    if (!current()) throw changed();
    const { joinUrl } = await join(AbortSignal.timeout(JOIN_TIMEOUT_MS));
    const viewerUrl = typeof joinUrl === "string" && joinUrl ? joinUrl : null;
    if (!current()) throw changed();
    if (!viewerUrl) throw new LocalizedPanelError("computer.err.noDesktopLink");
    if (window.ogb?.desktopViewer) {
      if (!(await window.ogb.desktopViewer.open(viewerUrl, title, botId))) throw new LocalizedPanelError("computer.err.openDesktop");
    } else if (fallbackTab) {
      fallbackTab.location.replace(viewerUrl);
      const taken = lease;
      if (taken) releaseWhenClosed(fallbackTab, () => void request("release", taken).catch(() => {}));
    } else if (window.ogb?.openExternal) {
      if (!(await window.ogb.openExternal(viewerUrl))) throw new LocalizedPanelError("computer.err.openDesktopLink");
    } else if (!window.open(viewerUrl, "_blank", "noopener")) {
      throw new LocalizedPanelError("computer.err.popupBlocked");
    }
  } catch (error) {
    fallbackTab?.close();
    if (lease) await request("release", lease).catch(() => {});
    throw error;
  }
}

function post(path: string, body: unknown): void {
  void fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true })
    .catch(() => {});
}

/**
 * Taking control where the person watches: the panel's own picture becomes the live, drivable desktop at once, and the
 * bot's computer calls wait. Leaving it in any way (Hand back, closing the panel or the page, another conversation)
 * gives the computer back, but only a hold this view took: another device's stays.
 */
export function useComputerTakeover({ botId, session, held, request, viewerClose }: {
  botId: string;
  /** The bot, conversation and computer being watched; a new one ends a session started on the old. */
  session: string;
  held: boolean;
  request: Request;
  /** A VPS keeps its viewer tunnel until told; the Local VM's viewer runs with the VM. */
  viewerClose: string | null;
}) {
  const [here, setHere] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [handingBack, setHandingBack] = useState(false);
  const lease = useRef<{ id: string; viewerClose: string | null } | null>(null);
  const closeRef = useRef(viewerClose);
  closeRef.current = viewerClose;

  const end = useCallback(() => {
    setHere(false);
    setExpanded(false);
  }, []);

  const leave = useCallback(() => {
    const mine = lease.current;
    lease.current = null;
    end();
    if (!mine) return;
    post(`/api/bots/${botId}/computer/control`, { action: "release", controlLeaseId: mine.id });
    if (mine.viewerClose) post(mine.viewerClose, {});
  }, [botId, end]);

  const take = useCallback(async (expand = false) => {
    const id = newLeaseId();
    const snap = await request("take", id);
    if (!snap.held) throw new Error(`${productName()} could not confirm computer control`);
    lease.current = snap.owned ? { id, viewerClose: closeRef.current } : null;
    setHere(true);
    setExpanded(expand);
  }, [request]);

  const handBack = useCallback(async () => {
    const close = lease.current?.viewerClose ?? closeRef.current;
    lease.current = null;
    end();
    setHandingBack(true);
    try {
      await request("release");
    } finally {
      setHandingBack(false);
      if (close) post(close, {});
    }
  }, [end, request]);

  useEffect(() => leave, [session, leave]);
  useEffect(() => {
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [leave]);
  useEffect(() => {
    if (!here || held) return;
    const timer = setTimeout(() => {
      lease.current = null;
      end();
    }, RELEASE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [here, held, end]);

  return { here, expanded, setExpanded, handingBack, take, handBack, leave };
}
