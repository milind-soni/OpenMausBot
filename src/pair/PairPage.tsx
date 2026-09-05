import { useEffect, useState } from "react";

import { defaultDeviceLabel, newAttemptId, pairWithCode, readSessionState, type EnvironmentDescriptor, type SessionState } from "../lib/session";

/** The page a pairing link opens: /pair#code=XXXX-XXXX-XXXX. Also what the
 * app shows instead of itself when a remote browser has no session yet. */
export function PairPage({ initialCode, reason }: { initialCode: string | null; reason?: string }) {
  const [code, setCode] = useState(initialCode ?? "");
  const [label, setLabel] = useState(defaultDeviceLabel());
  const [environment, setEnvironment] = useState<EnvironmentDescriptor | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // one id per code typed: a retry after a lost response reuses it, a new code gets a new one
  const [attemptId, setAttemptId] = useState(() => newAttemptId());

  useEffect(() => {
    void fetch("/.well-known/openmausbot/environment")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: EnvironmentDescriptor | null) => setEnvironment(d))
      .catch(() => setEnvironment(null));
    void readSessionState().then(setSession);
  }, []);

  const connected = session?.kind === "loopback" || session?.kind === "session";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await pairWithCode({ code, label, attemptId });
    setBusy(false);
    if (result.ok) {
      location.replace("/");
      return;
    }
    setError(result.error);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-app px-6 text-ink">
      <form onSubmit={submit} className="w-full max-w-[420px]">
        <h1 className="text-[20px] font-semibold">Connect to {environment?.label ?? "this OpenMausBot"}</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-secondary">
          {environment ? `Version ${environment.version} on ${environment.platform}. ` : ""}
          Enter the pairing code shown on the server. Codes work once and expire after five minutes.
        </p>
        {reason && !connected ? <p className="mt-3 text-[13px] text-ink-secondary">{reason}</p> : null}
        {connected ? (
          <p className="mt-4 text-[13.5px]">
            This browser is already connected.{" "}
            <a href="/" className="text-accent underline">
              Open the app
            </a>
          </p>
        ) : (
          <>
            <label className="mt-5 block text-[12px] font-medium text-ink-secondary" htmlFor="pair-code">
              Pairing code
            </label>
            <input
              id="pair-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setAttemptId(newAttemptId());
              }}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-[15px] tracking-[0.12em] text-ink outline-none focus:border-accent-border"
            />
            <label className="mt-4 block text-[12px] font-medium text-ink-secondary" htmlFor="pair-label">
              This device
            </label>
            <input
              id="pair-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
              className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-[14px] text-ink outline-none focus:border-accent-border"
            />
            {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
            <button
              type="submit"
              disabled={busy || code.replace(/[^a-z0-9]/gi, "").length < 12}
              className="mt-5 w-full rounded-md bg-accent px-4 py-2 text-[14px] font-medium text-accent-ink disabled:opacity-50"
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </>
        )}
      </form>
    </main>
  );
}
