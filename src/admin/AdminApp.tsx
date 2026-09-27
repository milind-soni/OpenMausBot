import { useEffect, useState } from "react";
import { NationAdminPage, type NationAdminConfig } from "../components/NationAdminPage";
import { api, ApiError } from "../lib/api-client";
import { signInPath } from "../lib/session";

export function AdminApp() {
  const [config, setConfig] = useState<NationAdminConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signIn, setSignIn] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const next = await api<NationAdminConfig>("/api/config", { signal: controller.signal, timeoutMs: 10_000 });
        if (controller.signal.aborted) return;
        setConfig(next);
        setError("");
        setSignIn(false);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setConfig(null);
        const needsSignIn = cause instanceof ApiError && (cause.status === 401 || cause.status === 403);
        setSignIn(needsSignIn);
        setError(needsSignIn ? "Sign in with your admin account, then return to this page." : "Could not reach the admin service. Please try again.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [attempt]);

  if (loading || error) return <main className="flex min-h-screen items-center justify-center bg-app p-6 text-ink">
    <section className="w-full max-w-md space-y-4 rounded-2xl border border-hairline/40 bg-panel p-8">
      <h1 className="text-xl font-semibold">NATION Admin</h1>
      <p role={error ? "alert" : "status"} className="text-sm text-ink-secondary">{loading ? "Checking admin access…" : error}</p>
      {signIn ? <a className="block underline" href={signInPath()}>Sign in with email</a> : error ? <button className="underline" onClick={() => setAttempt(value => value + 1)}>Try again</button> : null}
      <a className="block text-sm text-ink-secondary underline" href="/swarm/">Back to Swarm</a>
    </section>
  </main>;

  return <div className="flex h-full min-h-screen flex-col"><NationAdminPage config={config} /></div>;
}
