// "I need a calendar" — the first two rungs of the tool ladder, in the chat.
//
// A bot that needs a tool it does not have used to say so in prose and stop,
// leaving the person to go find the integration, connect it in a settings
// panel, come back and ask again. This is that, in the conversation: the apps
// we can actually connect for what it asked for, then the account name, then
// the ordinary connector card takes over and the job carries on.
//
// Two steps, one card. The name is asked on the second step rather than up
// front because that is the moment it means something — it is the name the
// bot will use when it asks you to approve an action later.
import { useState } from "react";
import { ArrowLeft, Check, Hammer, Loader2, PlugZap, Search, SearchX } from "lucide-react";

import { api, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  defaultAccountName,
  MAX_ACCOUNT_NAME,
  type ToolCandidate,
} from "../../shared/tool-request";

/** Small square mark for an app: its logo, or the first letter. */
function AppMark({ candidate }: { candidate: ToolCandidate }) {
  const [broken, setBroken] = useState(false);
  const source = !broken && candidate.logo
    ? candidate.logo
    : !broken && candidate.domain
      ? `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(candidate.domain)}`
      : null;
  if (!source) {
    return (
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-hairline/50 bg-control text-[13px] font-semibold text-ink-secondary">
        {candidate.label.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={source}
      alt=""
      onError={() => setBroken(true)}
      className="size-8 shrink-0 rounded-lg border border-hairline/40 bg-control object-contain"
    />
  );
}

export function ToolRequestCard({ threadId, message }: { threadId: string; message: Message }) {
  const card = message.card;
  const request = card?.toolRequest;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  if (!card || !request) return null;

  const endpoint = `/api/threads/${encodeURIComponent(threadId)}/tool-cards/${encodeURIComponent(message.id)}`;
  const post = async (action: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api(`${endpoint}/${action}`, { method: "POST", body: JSON.stringify(body ?? {}) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const chosen = request.candidates.find((candidate) => candidate.slug === request.chosen);

  // Settled: say how it ended and stop offering buttons for it.
  if (request.settled) {
    const note = request.settled === "building"
      ? t("toolLadder.settled.building")
      : request.settled === "searching"
      ? t("toolLadder.settled.searching")
      : request.settled === "connecting"
      ? t("toolLadder.settled.connecting", { app: chosen?.label ?? request.capability })
      : request.settled === "ready"
        ? t("toolLadder.settled.ready", { app: chosen?.label ?? request.capability })
        : request.settled === "later"
          ? t("toolLadder.settled.later")
          // Falling off the ladder is told, never shrugged off.
          : t("toolLadder.settled.none", { capability: request.capability });
    const missed = request.settled === "none";
    const searching = request.settled === "searching" || request.settled === "building";
    return (
      <Shell dim={!missed}>
        {missed || searching ? (
          <div className="text-[15px] font-semibold text-ink">
            {searching
              ? t("toolLadder.title", { capability: request.capability })
              : t("toolLadder.none.title", { capability: request.capability })}
          </div>
        ) : (
          <Header capability={request.capability} reason={request.reason} />
        )}
        <div className="mt-2 flex items-center gap-1.5 text-[13px] text-ink-secondary">
          {searching ? <Loader2 size={14} className="animate-spin" /> : missed ? <SearchX size={14} /> : <Check size={14} className="text-success" />}
          {note}
        </div>
        {/* The ladder's next rung. A dead end is where this feature is most
            worth something: not "I can't", but "shall I go and look?" */}
        {missed && (
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {/* Look first: something that already exists and is used by other
                people beats something written on the spot. Building is the
                answer when looking comes back empty. */}
            <button
              onClick={() => void post("build")}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
            >
              <Hammer size={13} />
              {t("toolLadder.build")}
            </button>
            <button
              onClick={() => void post("look")}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full border border-hairline/50 px-3.5 py-1.5 text-[13.5px] text-ink hover:bg-control disabled:opacity-40"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
              {t("toolLadder.look")}
            </button>
          </div>
        )}
        {error && <p className="mt-2 text-[12.5px] text-danger">{error}</p>}
      </Shell>
    );
  }

  if (request.step === "name" && chosen) {
    const suggestion = defaultAccountName(request.candidates, chosen.slug);
    return (
      <Shell>
        <Header capability={request.capability} reason={request.reason} />
        <div className="mt-3 flex items-center gap-2.5">
          <AppMark candidate={chosen} />
          <span className="text-[14.5px] font-medium text-ink">{chosen.label}</span>
        </div>
        <div className="mt-3">
          <div className="text-[13.5px] font-medium text-ink">{t("toolLadder.name.title", { app: chosen.label })}</div>
          {/* the reason, attached: this is not paperwork, it is the name the
              bot will say back to you when it asks to act */}
          <div className="mt-0.5 text-[12.5px] leading-snug text-ink-secondary">{t("toolLadder.name.why")}</div>
          <input
            autoFocus
            value={name}
            maxLength={MAX_ACCOUNT_NAME}
            placeholder={suggestion}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !busy) void post("connect", { slug: chosen.slug, alias: name.trim() });
            }}
            className="mt-2 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[t("toolLadder.name.personal"), t("toolLadder.name.work")].map((preset) => (
              <button
                key={preset}
                onClick={() => setName(preset)}
                className="rounded-full border border-hairline/50 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="mt-2 text-[12.5px] text-danger">{error}</p>}
        <div className="mt-3 flex items-center justify-between gap-3">
          <button
            onClick={() => void post("back")}
            disabled={busy}
            className="flex items-center gap-1 text-[12.5px] text-ink-secondary hover:text-ink disabled:opacity-40"
          >
            <ArrowLeft size={13} /> {t("toolLadder.back")}
          </button>
          <button
            onClick={() => void post("connect", { slug: chosen.slug, alias: name.trim() })}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[13.5px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
            {t("toolLadder.name.continue", { app: chosen.label })}
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <Header capability={request.capability} reason={request.reason} />
      <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
        {request.candidates.map((candidate, index) => (
          <button
            key={candidate.slug}
            disabled={busy}
            onClick={() => void post("choose", { slug: candidate.slug })}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-2.5 text-left",
              index > 0 && "border-t border-hairline/40",
              "hover:bg-raised-hover/60 disabled:hover:bg-transparent",
            )}
          >
            <AppMark candidate={candidate} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="text-[14.5px] font-medium text-ink">{candidate.label}</span>
                {candidate.connected && (
                  <span className="flex items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-[11px] font-medium text-success">
                    <Check size={10} /> {t("toolLadder.connected")}
                  </span>
                )}
              </span>
              {candidate.blurb && (
                <span className="block text-[12.5px] leading-snug text-ink-secondary">{candidate.blurb}</span>
              )}
            </span>
          </button>
        ))}
      </div>
      {error && <p className="mt-2 text-[12.5px] text-danger">{error}</p>}
      {/* the way out. Not decoration — it is what makes the rest safe to click */}
      <div className="mt-3 flex justify-end">
        <button
          onClick={() => void post("later")}
          disabled={busy}
          className="rounded-full px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
        >
          {t("toolLadder.later")}
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children, dim }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <div
      className={cn(
        "w-full max-w-[560px] rounded-2xl border bg-card p-4",
        dim ? "border-hairline/30 opacity-70" : "border-accent/40",
      )}
    >
      {children}
    </div>
  );
}

function Header({ capability, reason }: { capability: string; reason?: string }) {
  return (
    <>
      <div className="text-[15px] font-semibold text-ink">{t("toolLadder.title", { capability })}</div>
      {reason && <div className="mt-0.5 text-[13px] leading-snug text-ink-secondary">{reason}</div>}
    </>
  );
}
