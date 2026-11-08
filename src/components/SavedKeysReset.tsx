import { useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { savedKeysUnreadable } from "@/lib/saved-keys-reset";

/** "Reset saved keys", shown only when this app's desktop could not read its saved keys this launch. The desktop asks
 * the person before it moves the unreadable file aside and restarts. */
export function SavedKeysReset() {
  const [unreadable, setUnreadable] = useState(false);
  useEffect(() => {
    let live = true;
    void savedKeysUnreadable().then((answer) => { if (live) setUnreadable(answer); });
    return () => { live = false; };
  }, []);
  if (!unreadable) return null;
  return (
    <button
      type="button"
      onClick={() => void window.ogb?.credentialStore?.reset()}
      className="ms-2 font-medium underline underline-offset-2 hover:opacity-80"
    >
      {t("connectors.resetSavedKeys")}
    </button>
  );
}
