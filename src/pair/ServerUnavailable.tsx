import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { brand } from "../lib/brand";
import { readSessionState, type SessionState } from "../lib/session";

const MARK_SRC = `${import.meta.env.BASE_URL}nation-mark.png`;
/** Seconds between automatic checks: soon at first, then twice a minute. */
const RETRY_SECONDS = [3, 5, 10, 15, 30];

const primary = "mt-6 w-full rounded-lg bg-nation px-4 py-2.5 text-[15px] font-semibold text-nation-ink transition-opacity disabled:opacity-50";

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-nation-ink px-5 py-10 text-white sm:px-8 sm:py-16">
      <div className="w-full max-w-[400px]">
        <img src={MARK_SRC} alt="" width={48} height={48} className="size-12 rounded-xl" />
        <h1 className="mt-8 text-[26px] font-bold leading-tight tracking-tight">{title}</h1>
        {children}
        <p className="mt-8 text-center text-[12.5px] text-white/50">
          Need help?{" "}
          <a href="https://t.me/thenation_city" target="_blank" rel="noopener noreferrer" className="text-nation underline decoration-nation/40 underline-offset-2">
            Message us on Telegram
          </a>
        </p>
      </div>
    </main>
  );
}

/** The first page when this browser cannot reach the server. It cannot tell a
 * visitor from a member, so it opens neither the sign-in page nor an empty
 * workspace: it says so, keeps asking, and loads the page again as soon as the
 * server answers, which then goes wherever that answer leads. */
export function ServerUnavailable({ probe = readSessionState }: { probe?: () => Promise<SessionState> }) {
  const [round, setRound] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(RETRY_SECONDS[0]!);
  const [checking, setChecking] = useState(false);
  const busy = useRef(false);

  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    if ((await probe()).kind !== "unreachable") {
      location.reload();
      return;
    }
    busy.current = false;
    setChecking(false);
    setRound((n) => n + 1);
  }, [probe]);

  useEffect(() => {
    let left = RETRY_SECONDS[Math.min(round, RETRY_SECONDS.length - 1)]!;
    setSecondsLeft(left);
    const timer = setInterval(() => {
      left -= 1;
      setSecondsLeft(left);
      if (left > 0) return;
      clearInterval(timer);
      void check();
    }, 1000);
    return () => clearInterval(timer);
  }, [round, check]);

  return (
    <Notice title={`We can't reach ${brand().name} right now`}>
      <p className="mt-2 text-[15px] leading-relaxed text-white/70">
        Your connection may have dropped, or we are busy for a moment. This page carries on by itself as soon as it connects.
      </p>
      <button type="button" className={primary} disabled={checking} onClick={() => void check()}>
        {checking ? "Checking…" : "Try again now"}
      </button>
      <p className="mt-3 text-center text-[13px] text-white/50">
        {checking ? "Checking the connection…" : `Trying again in ${secondsLeft} s`}
      </p>
    </Notice>
  );
}

/** When the page's own code will not load even after loading the page again. */
export function LoadFailed() {
  return (
    <Notice title="This page didn't load completely">
      <p className="mt-2 text-[15px] leading-relaxed text-white/70">
        A new version may have just been released, or the connection dropped. Reloading usually fixes it.
      </p>
      <button type="button" className={primary} onClick={() => location.reload()}>
        Reload
      </button>
    </Notice>
  );
}
