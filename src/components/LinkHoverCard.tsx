// A preview card that floats above a link in a bot reply. It opens when the
// pointer rests on the link, on keyboard focus, or on a long press, and
// shows what the app knows about the link without fetching it.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, CircleDot, GitCommitHorizontal, GitPullRequest, Github, Globe, Hash } from "lucide-react";
import { t } from "@/lib/i18n";
import { githubRefLabel, type GithubRef, type GithubRefKind } from "@/lib/github-refs";

export const HOVER_OPEN_DELAY_MS = 300;
/** time to move the pointer from the link into the card */
export const HOVER_CLOSE_GRACE_MS = 150;
export const LONG_PRESS_MS = 500;
const GAP = 8;
const EDGE = 8;

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** Above the link and centered on it, inside the window. Below when there
 * is no room above. */
export function placeCard(anchor: Box, card: { width: number; height: number }, view: { width: number; height: number }) {
  const maxLeft = Math.max(EDGE, view.width - card.width - EDGE);
  const left = Math.min(maxLeft, Math.max(EDGE, anchor.left + anchor.width / 2 - card.width / 2));
  const above = anchor.top - GAP - card.height;
  if (above >= EDGE) return { left, top: above, side: "above" as const };
  const below = anchor.bottom + GAP;
  return { left, top: Math.max(EDGE, Math.min(below, view.height - card.height - EDGE)), side: "below" as const };
}

export const GITHUB_REF_ICONS: Record<GithubRefKind, typeof GitPullRequest> = {
  pull: GitPullRequest,
  issue: CircleDot,
  commit: GitCommitHorizontal,
  ref: Hash,
};

function hostOf(url: URL): string {
  return url.hostname.replace(/^www\./i, "");
}

function pathOf(url: URL): string {
  const rest = `${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
  try {
    return decodeURI(rest);
  } catch {
    return rest;
  }
}

/** The card itself: a title, a short muted description, and the site with
 * an outward arrow, in the composer's surface and radius. */
export function LinkPreviewCard({ href, github }: { href: string; github?: GithubRef | null }) {
  let url: URL | null = null;
  try {
    url = new URL(href);
  } catch {
    url = null;
  }
  const host = url ? hostOf(url) : href;
  const Icon = github ? GITHUB_REF_ICONS[github.kind] : null;
  const title = github
    ? github.kind === "commit"
      ? t("links.card.commit", { id: githubRefLabel(github, false) })
      : t(github.kind === "pull" ? "links.card.pullRequest" : github.kind === "issue" ? "links.card.issue" : "links.card.reference", { id: githubRefLabel(github, false) })
    : host;
  const description = github ? `${github.owner}/${github.repo}` : url ? pathOf(url) : "";
  return (
    <div className="w-[min(20rem,calc(100vw-1rem))] rounded-3xl bg-composer p-4 text-ink shadow-lg ring-1 ring-hairline/40">
      <div className="flex items-baseline gap-2">
        {Icon && <Icon size={15} aria-hidden="true" className="shrink-0 self-center text-ink-secondary" />}
        <div dir="auto" className="min-w-0 line-clamp-2 break-words text-[15px] font-semibold leading-snug">{title}</div>
      </div>
      {description && (
        <div dir="ltr" className="mt-1 line-clamp-3 break-all text-[13px] leading-5 text-ink-secondary [unicode-bidi:isolate]">
          {description}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2 text-[13px] leading-5 text-ink-tertiary">
        {github ? <Github size={14} aria-hidden="true" className="shrink-0" /> : <Globe size={14} aria-hidden="true" className="shrink-0" />}
        <span dir="ltr" className="min-w-0 flex-1 truncate [unicode-bidi:isolate]">{host}</span>
        <ArrowUpRight size={14} aria-hidden="true" className="shrink-0 rtl:-scale-x-100" />
      </div>
    </div>
  );
}

/** Wraps a link: hover (after a short delay), keyboard focus or a long press
 * opens the card, leaving closes it after a grace period that lets the
 * pointer move into the card. */
export function LinkHoverCard({ href, github, children }: { href: string; github?: GithubRef | null; children: (anchor: AnchorProps) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressed = useRef(false);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };
  const later = useCallback((value: boolean, ms: number) => {
    clear();
    timer.current = setTimeout(() => setOpen(value), ms);
  }, []);
  useEffect(() => clear, []);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = anchorRef.current, card = cardRef.current;
      if (!anchor || !card) return;
      const rects = anchor.getClientRects();
      const box = rects.length ? rects[0]! : anchor.getBoundingClientRect();
      const spot = placeCard(box, { width: card.offsetWidth, height: card.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
      card.style.left = `${spot.left}px`;
      card.style.top = `${spot.top}px`;
      card.dataset.side = spot.side;
      card.style.visibility = "visible";
    };
    update();
    const close = () => setOpen(false);
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchorRef.current?.contains(target) && !cardRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("resize", update);
    // a scrolled transcript moves the link away from the card
    window.addEventListener("scroll", close, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open]);

  const anchor: AnchorProps = {
    ref: (node) => { anchorRef.current = node; },
    "aria-describedby": open ? id : undefined,
    onPointerEnter: (event) => {
      if (event.pointerType === "touch") return;
      later(true, HOVER_OPEN_DELAY_MS);
    },
    onPointerLeave: (event) => {
      if (event.pointerType === "touch") return;
      later(false, HOVER_CLOSE_GRACE_MS);
    },
    onFocus: (event) => {
      // keyboard focus only: a click focuses the link too
      if (event.currentTarget.matches(":focus-visible")) {
        clear();
        setOpen(true);
      }
    },
    onBlur: () => later(false, 0),
    onKeyDown: (event) => {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        clear();
        setOpen(false);
      }
    },
    onPointerDown: (event) => {
      if (event.pointerType !== "touch") return;
      pressed.current = false;
      pressStart.current = { x: event.clientX, y: event.clientY };
      clear();
      timer.current = setTimeout(() => {
        pressed.current = true;
        setOpen(true);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event) => {
      const start = pressStart.current;
      if (event.pointerType !== "touch" || !start || pressed.current) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
        pressStart.current = null;
        clear();
      }
    },
    onPointerUp: (event) => {
      if (event.pointerType !== "touch") return;
      pressStart.current = null;
      if (!pressed.current) clear();
    },
    onClick: (event) => {
      // the long press showed the card; lifting the finger must not also
      // open the link
      if (pressed.current) {
        event.preventDefault();
        pressed.current = false;
      }
    },
    onContextMenu: (event) => {
      if (pressed.current || open) event.preventDefault();
    },
  };

  return (
    <>
      {children(anchor)}
      {open && createPortal(
        <div
          ref={cardRef}
          id={id}
          role="tooltip"
          data-link-preview=""
          className="fixed z-50"
          style={{ left: 0, top: 0, visibility: "hidden" }}
          onPointerEnter={(event) => { if (event.pointerType !== "touch") clear(); }}
          onPointerLeave={(event) => { if (event.pointerType !== "touch") later(false, HOVER_CLOSE_GRACE_MS); }}
        >
          <LinkPreviewCard href={href} github={github} />
        </div>,
        document.body,
      )}
    </>
  );
}

export type AnchorProps = {
  ref: (node: HTMLElement | null) => void;
  "aria-describedby"?: string;
  onPointerEnter: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onFocus: (event: React.FocusEvent<HTMLElement>) => void;
  onBlur: (event: React.FocusEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  onClick: (event: React.MouseEvent<HTMLElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
};
