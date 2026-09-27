import { useEffect, useRef, useState } from "react";
import { api } from "./api-client";

export interface AccountSession {
  kind: string;
  email?: string;
  label?: string;
}

/** Shared by Settings and the profile menu: revoke the browser's session
 * before reloading the authentication gate and discarding workspace state. */
export function useAccountSession() {
  const [session, setSession] = useState<AccountSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void api<AccountSession>("/api/auth/session", { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setSession(value ?? null); })
      .catch(() => { if (!controller.signal.aborted) setSession(null); });
    return () => controller.abort();
  }, []);

  const onSignOut = async () => {
    if (pending.current || session?.kind !== "session") return;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}", timeoutMs: 15_000 });
      location.replace(import.meta.env.BASE_URL);
    } catch {
      pending.current = false;
      setBusy(false);
      setFailed(true);
    }
  };

  return { session, busy, failed, onSignOut };
}
