// Right-click on a file a bot attached shows the original it was copied from in Finder or the file manager, never the
// app's own copy: an original that moved or is gone says so. Only the desktop app on the computer that holds the file
// offers it; a phone, the web or a window connected to another computer gets no menu.
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { FolderOpen } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { MENU_ITEM, MENU_SHEET } from "./menu-recipe";

const REVEALABLE_PATH = /^(?:\/(?!\/)|[a-zA-Z]:[\\/])/;
const ITEM_CLASS = `${MENU_ITEM} text-ink hover:bg-menu-hover [&>svg]:text-ink-secondary`;

type Reveal = NonNullable<NonNullable<Window["ogb"]>["revealInFolder"]>;

function revealBridge(): Reveal | undefined {
  const ogb = typeof window === "undefined" ? undefined : window.ogb;
  return ogb?.remoteClient?.active ? undefined : ogb?.revealInFolder;
}

type OpenFolder = NonNullable<NonNullable<Window["ogb"]>["openFolder"]>;

/** Desktop app on the computer that holds the path: a folder a chat links to opens in Finder or Explorer. True only when
 * it opened; a file, a missing path, a phone, the web or a connected window answer false and keep their own handling. */
export async function openLinkedFolder(folderPath: string, open: OpenFolder | undefined = openFolderBridge()): Promise<boolean> {
  if (!open || !REVEALABLE_PATH.test(folderPath)) return false;
  try {
    return await open(folderPath) === "opened";
  } catch {
    return false;
  }
}

function openFolderBridge(): OpenFolder | undefined {
  const ogb = typeof window === "undefined" ? undefined : window.ogb;
  return ogb?.remoteClient?.active ? undefined : ogb?.openFolder;
}

export function canRevealOriginal(source: string | undefined, reveal: Reveal | undefined = revealBridge()): source is string {
  return Boolean(reveal) && typeof source === "string" && REVEALABLE_PATH.test(source);
}

export function revealOriginalLabel(platform: string | undefined): string {
  return t(platform === "darwin" ? "attach.showInFinder" : "attach.showInFolder");
}

/** Empty when shown; otherwise what to tell the person. */
export async function revealOriginal(source: string, reveal: Reveal): Promise<string> {
  try {
    const result = await reveal(source);
    return result === "shown" ? "" : t(result === "missing" ? "attach.originalMissing" : "attach.revealFailed");
  } catch {
    return t("attach.revealFailed");
  }
}

export function useRevealOriginalMenu() {
  const [at, setAt] = useState<{ left: number; top: number; source: string; problem?: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Escape or a successful reveal removes the menu while its button has focus: give focus back to where it was.
  const returnFocus = useRef<HTMLElement | null>(null);
  const closeAndRestoreFocus = () => {
    setAt(null);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus();
  };
  useEffect(() => {
    if (!at) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: Event) => { if (!(event.target instanceof Node && menuRef.current?.contains(event.target))) setAt(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("scroll", close, true); };
  }, [at]);
  const reveal = revealBridge();
  const label = revealOriginalLabel(typeof window === "undefined" ? undefined : window.ogb?.platform);
  const show = async (source: string) => {
    const problem = reveal ? await revealOriginal(source, reveal) : t("attach.revealFailed");
    if (!problem && menuRef.current?.contains(document.activeElement)) return closeAndRestoreFocus();
    setAt((current) => current?.source !== source ? current : problem ? { ...current, problem } : null);
  };
  return {
    /** Spread onto the element that holds one attachment. */
    targetProps: (source: string | undefined) => !canRevealOriginal(source, reveal) ? {} : {
      onContextMenu: (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const active = document.activeElement;
        returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : event.currentTarget;
        setAt({ left: Math.max(8, Math.min(event.clientX, window.innerWidth - 268)), top: Math.max(8, Math.min(event.clientY, window.innerHeight - 110)), source });
      },
    },
    menu: at && createPortal(
      <div ref={menuRef} role="group" aria-label={label} style={{ left: at.left, top: at.top }}
        className={cn("fixed z-50 w-[260px]", MENU_SHEET)}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeAndRestoreFocus(); } }}>
        <button type="button" onClick={() => void show(at.source)} title={at.source} className={ITEM_CLASS}>
          <FolderOpen size={16} />{label}
        </button>
        {at.problem && <p role="alert" className="px-2 pb-1 text-[13px] leading-[18px] text-danger">{at.problem}</p>}
      </div>,
      document.body,
    ),
  };
}
