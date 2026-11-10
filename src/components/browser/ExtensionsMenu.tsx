// The browser panel's Extensions menu: the extensions installed in this bot's browser, each opening its own page for the
// person holding the browser. The server picks the page from the extension's id; chrome:// pages never open from here.
import { Puzzle } from "lucide-react";
import { useEffect, useRef } from "react";

import { t } from "@/lib/i18n";

export interface BrowserExtension {
  id: string;
  name: string;
}

export function extensionsOf(value: unknown): BrowserExtension[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const { id, name } = (entry ?? {}) as Record<string, unknown>;
    return typeof id === "string" && typeof name === "string" ? [{ id, name }] : [];
  });
}

const item = "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-inset disabled:cursor-not-allowed disabled:opacity-40";

export function ExtensionsMenu({ ready, extensions, onList, onOpen }: {
  /** The person holds the browser, so an extension page can open. */
  ready: boolean;
  /** Null until the browser has sent its list. */
  extensions: readonly BrowserExtension[] | null;
  onList: () => void;
  onOpen: (id: string) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  // Control can arrive while the menu is already open: ask for the list then too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready && menu.current?.open) onList(); }, [ready]);
  return (
    <details ref={menu} className="relative shrink-0" onToggle={(event) => { if (event.currentTarget.open && ready) onList(); }}>
      <summary className="list-none cursor-pointer rounded-md p-1.5 text-ink-secondary hover:bg-inset hover:text-ink [&::-webkit-details-marker]:hidden" aria-label={t("browser.extensions.title")} title={t("browser.extensions.title")}><Puzzle size={16} /></summary>
      <div className="absolute right-0 top-full z-40 mt-2 flex max-h-80 w-56 flex-col overflow-y-auto rounded-xl border border-hairline/50 bg-card p-1 text-[12px] text-ink shadow-xl" role="menu">
        <div className="px-3 pb-1 pt-1.5 text-[11px] text-ink-tertiary">{t("browser.extensions.title")}</div>
        {!ready ? <div className="px-3 py-1.5 text-ink-secondary">{t("browser.extensions.takeControl")}</div>
          : extensions && extensions.length === 0 ? <div className="px-3 py-1.5 text-ink-secondary">{t("browser.extensions.empty")}</div>
          : (extensions ?? []).map((extension) => (
            <button key={extension.id} type="button" role="menuitem" className={item} onClick={() => { menu.current?.removeAttribute("open"); onOpen(extension.id); }}>
              <span className="truncate">{extension.name}</span>
            </button>
          ))}
      </div>
    </details>
  );
}
