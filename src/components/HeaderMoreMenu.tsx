import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";

export interface HeaderMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
}

interface HeaderMoreMenuProps {
  items: HeaderMenuItem[];
  className?: string;
}

export function HeaderMoreMenu({ items, className }: HeaderMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const [menuCoords, setMenuCoords] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Position the portaled menu directly under the trigger button
  const updatePosition = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuCoords({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  };

  const handleToggle = () => {
    if (!open) {
      updatePosition();
      setOpen(true);
    } else {
      setOpen(false);
    }
  };

  // Keyboard navigation & outside click
  useEffect(() => {
    if (!open) return;

    // Focus first item upon opening
    const rafId = requestAnimationFrame(() => {
      const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
      firstItem?.focus();
    });

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }

      if (!menuRef.current) return;
      const menuItems = Array.from(
        menuRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'),
      );
      if (menuItems.length === 0) return;

      const activeIdx = menuItems.indexOf(document.activeElement as HTMLButtonElement);

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextIdx = (activeIdx + 1) % menuItems.length;
        menuItems[nextIdx]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prevIdx = (activeIdx - 1 + menuItems.length) % menuItems.length;
        menuItems[prevIdx]?.focus();
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) {
          const prevIdx = (activeIdx - 1 + menuItems.length) % menuItems.length;
          menuItems[prevIdx]?.focus();
        } else {
          const nextIdx = (activeIdx + 1) % menuItems.length;
          menuItems[nextIdx]?.focus();
        }
      }
    };

    const onScrollOrResize = () => {
      updatePosition();
    };

    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  return (
    <div className={cn("relative inline-flex items-center", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="More actions"
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            if (!open) {
              e.preventDefault();
              updatePosition();
              setOpen(true);
            }
          }
        }}
        className={cn(
          "rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink transition-colors",
          open && "bg-raised text-ink",
        )}
      >
        <MoreHorizontal size={16} />
      </button>

      {open &&
        menuCoords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="More actions"
            style={{
              position: "fixed",
              top: `${menuCoords.top}px`,
              right: `${menuCoords.right}px`,
              zIndex: 50,
            }}
            className="w-48 overflow-hidden rounded-xl border border-hairline/60 bg-panel p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100"
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                  triggerRef.current?.focus();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-raised-hover focus:bg-raised-hover focus:outline-none"
              >
                {item.icon && <span className="shrink-0 text-ink-secondary">{item.icon}</span>}
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
