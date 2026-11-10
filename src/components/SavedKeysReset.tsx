import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { savedKeysUnreadable } from "@/lib/saved-keys-reset";

/** The desktop's open "Reset saved keys" question, shared by every button so a remounted one cannot ask again. */
let asking: Promise<void> | null = null;

/** "Reset saved keys", shown only when this app's desktop could not read its saved keys this launch. The desktop asks
 * the person before it moves the unreadable file aside and restarts; the button waits for that answer, so a second
 * click cannot open a second question. With `notice`, it comes in its own warning line, for a page with no other
 * warning to sit in. */
export function SavedKeysReset({ notice = false }: { notice?: boolean }) {
  const [unreadable, setUnreadable] = useState(false);
  const [pending, setPending] = useState(() => asking !== null);
  useEffect(() => {
    let live = true;
    void savedKeysUnreadable().then((answer) => { if (live) setUnreadable(answer); });
    // The warning this button sits in can be swapped for another while the question is open: the new button waits too.
    void asking?.finally(() => { if (live) setPending(false); });
    return () => { live = false; };
  }, []);
  if (!unreadable) return null;
  const reset = () => {
    if (asking) return;
    setPending(true);
    const request = Promise.resolve(window.ogb?.credentialStore?.reset()).then(() => {}, () => {});
    asking = request.finally(() => {
      asking = null;
      setPending(false);
    });
  };
  const button = (
    <button
      type="button"
      onClick={reset}
      disabled={pending}
      className="ms-2 font-medium underline underline-offset-2 hover:opacity-80 disabled:opacity-60"
    >
      {t("connectors.resetSavedKeys")}
    </button>
  );
  if (!notice) return button;
  return (
    <div className="mb-3 flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-[13px] text-warning">
      <TriangleAlert size={14} className="mt-px shrink-0" />
      <span>
        {t("connectors.savedKeysUnreadable")}
        {button}
      </span>
    </div>
  );
}
