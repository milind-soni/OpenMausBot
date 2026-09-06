// The bot's browser, as the panel sees it today: which engine, whether it is
// installed here, and how to get it. The bot drives it through its tools;
// the pictures it takes land in the chat. A live view with takeover is the
// next step of docs/plans/browser-engine.md and slots in here.
import { useState } from "react";

import { browserUnavailableReason } from "@/lib/feature-flags";
import { useStore } from "@/state/store";
import type { Bot } from "@/state/store";

export function BrowserPanel({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const engine = state.config?.browserEngine;
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installing = requested || engine?.installing === true;

  const install = async () => {
    setError(null);
    setRequested(true);
    try {
      const response = await fetch("/api/browser-engine/install", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `The server answered ${response.status}.`);
        setRequested(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setRequested(false);
    }
  };

  if (engine?.kind === "engine") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-2 rounded-xl bg-card p-5">
        <div className="text-[15px] font-medium text-ink">{bot.name} has its own browser</div>
        <p className="text-[13px] leading-relaxed text-ink-secondary">
          agent-browser {engine.version ?? ""} runs it as an isolated session with its own logins, which persist across restarts.
          Pages the bot looks at appear in the chat as screenshots. A live view you can watch and take over is coming next.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-3 rounded-xl bg-card p-5">
      <div className="text-[15px] font-medium text-ink">Browser engine not installed</div>
      <p className="text-[13px] leading-relaxed text-ink-secondary">{browserUnavailableReason(state.config)}</p>
      {engine?.installable ? (
        <button
          type="button"
          onClick={() => void install()}
          disabled={installing}
          className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
        >
          {installing ? "Installing… (a one-time download of about 160 MB)" : "Install the browser engine"}
        </button>
      ) : null}
      {engine?.installError ? (
        <p role="alert" className="text-[12px] text-danger">Last attempt failed: {engine.installError}</p>
      ) : null}
      {error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}
