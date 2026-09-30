import { useState } from "react";

import { newAttemptId, signInWithBrowserGrant } from "../lib/session";

/** The OMB Cloud page's "Use in your browser" lands here (/pair#signin=…):
 * whose Cloud this is, as the machine recorded it, and one Continue. Nothing
 * is redeemed until the person continues, so a link someone else sent never
 * signs this browser in to their Cloud unseen. The credential is never shown. */
export function BrowserSignInPage({ credential, owner }: { credential: string; owner: string }) {
  // One attempt per page: a retry after a lost answer gets the same session back.
  const [attemptId] = useState(() => newAttemptId());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function continueSignIn() {
    setBusy(true);
    setError(null);
    const result = await signInWithBrowserGrant(credential, attemptId);
    if (result.ok) {
      location.replace("/");
      return;
    }
    setBusy(false);
    setError(result.error);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-app px-6 text-ink">
      <div className="w-full max-w-[420px]">
        <h1 className="text-[20px] font-semibold">Signing in to {owner}’s Cloud</h1>
        <p className="mt-1.5 text-[13.5px] text-ink-secondary">Not your email? Close this tab.</p>
        {error ? <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p> : null}
        <button type="button" onClick={() => void continueSignIn()} disabled={busy}
          className="mt-5 w-full rounded-md bg-accent px-4 py-2 text-[14px] font-medium text-accent-ink disabled:opacity-50">
          {busy ? "Signing in…" : "Continue"}
        </button>
      </div>
    </main>
  );
}
