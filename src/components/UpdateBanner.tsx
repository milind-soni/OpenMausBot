// Auto-update popup — a small card floating bottom-left, driven by the
// preload's updater bridge (this computer's page and the person's own Cloud
// page). Renders nothing in the browser/dev (no bridge). Updates download by
// themselves, so it stays away while one checks, downloads or prepares, and
// appears only when there is something to do: a restart to apply (always the
// person's click), a hand-off to finish, or a failure.
import { useEffect, useState } from "react";
import { Loader2, PackageOpen, RefreshCw, Sparkles, X } from "lucide-react";
import { useUpdaterState } from "@/lib/updater";
import { brand } from "../lib/brand";

// The one action button in the card. Disabled drops the accent fill for the
// flat raised grey — the "I heard you" the click needs while the main process
// gets going.
const primaryAction =
  "flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white transition-colors disabled:cursor-default disabled:bg-control disabled:text-ink-secondary";

// electron-updater surfaces failures as a whole HTTP dump — status line,
// every response header, stack trace. That is unreadable in a 300px popup,
// so name the two cases that actually happen and clip anything else to its
// first line.
function friendlyError(message?: string): string {
  if (!message) return "Something went wrong.";
  if (/cannot find .*\.yml|404/i.test(message))
    return "No update has been published for this platform yet.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(message))
    return "Couldn't reach the update server.";
  return message.split("\n")[0].slice(0, 140);
}

export function UpdateBanner() {
  const s = useUpdaterState();
  // dismissal is per status+version, so the popup returns for the next update
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A click has to go renderer → main → broadcast before the real status
  // arrives. Latch the pressed button as busy on the same frame so it greys
  // out immediately; the incoming status clears the latch.
  const [pending, setPending] = useState<"install" | "check" | null>(null);
  const status = s?.status;
  useEffect(() => setPending(null), [status]);

  if (!s || s.status === "idle" || s.status === "checking" || s.status === "downloading" || s.status === "preparing") return null;
  const key = `${s.status}:${s.version ?? ""}`;
  if (dismissed === key) return null;
  const updater = window.ogb!.updater!;

  // while it restarts the card owns the moment: no dismissing, no second click
  const installing = s.status === "installing";
  // Ubuntu system packages can't be swapped under a running app, so the
  // command is copied and a terminal opens; the user finishes there.
  // Nothing restarts, and the card has to stop promising that it will.
  const handoff = s.installMode === "handoff";

  const title =
    s.status === "downloaded"
      ? // named: on My Cloud's page it is this app that restarts, not the Cloud
        `${brand().name} ${s.version} is ready`
      : installing
        ? handoff
          ? "Opening a terminal…"
          : "Restarting to update…"
        : s.status === "handed-off"
          ? "Finish in a terminal"
          : "Update failed";
  const subtitle =
    s.status === "downloaded"
      ? handoff
        ? "Copy the install command and open a terminal."
        : "Restart to finish updating."
      : installing
        ? handoff
          ? "Copying the command…"
          : s.message || `${brand().name} will reopen in a moment.`
        : s.status === "handed-off"
          ? s.terminalOpened
            ? "Command copied — paste it in the terminal that opened."
            : "Command copied — paste it in a terminal to finish."
          : s.retryable === false
            ? `${friendlyError(s.message?.split(" Quit and reopen ")[0])} Quit and reopen ${brand().name} before trying the update again.`
            : friendlyError(s.message);

  return (
    <div className="animate-panel-in fixed bottom-4 left-4 z-50 w-[300px] rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">{title}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-secondary" title={subtitle}>
            {subtitle}
          </div>
        </div>
        {!installing && (
          <button
            onClick={() => setDismissed(key)}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {s.status === "handed-off" && s.command && (
        <code className="mt-2.5 block overflow-x-auto rounded-lg bg-control px-2 py-1.5 font-mono text-[11.5px] whitespace-pre text-ink-secondary">
          {s.command}
        </code>
      )}

      {installing && (
        <div className="mt-2.5 flex gap-2">
          <button
            disabled
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] font-medium text-ink-secondary"
          >
            <Loader2 size={13} className="animate-spin" /> {handoff ? "Opening…" : "Restarting…"}
          </button>
        </div>
      )}

      {!installing && (
        <div className="mt-2.5 flex gap-2">
          {s.status === "downloaded" && (
            <button
              onClick={() => {
                setPending("install");
                void updater.install();
              }}
              disabled={pending !== null}
              className={primaryAction}
            >
              {pending === "install" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> {handoff ? "Opening…" : "Restarting…"}
                </>
              ) : handoff ? (
                <>
                  <PackageOpen size={13} /> Install
                </>
              ) : (
                <>
                  <RefreshCw size={13} /> Restart to update
                </>
              )}
            </button>
          )}
          {s.status === "error" && s.retryable !== false && (
            <button
              onClick={() => {
                setPending("check");
                void updater.check();
              }}
              disabled={pending !== null}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:text-ink-secondary disabled:hover:bg-control"
            >
              {pending === "check" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Checking…
                </>
              ) : (
                "Try again"
              )}
            </button>
          )}
          <button
            onClick={() => setDismissed(key)}
            disabled={pending !== null}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {/* after a hand-off there is nothing left to postpone */}
            {s.status === "handed-off" || s.retryable === false ? "Dismiss" : "Later"}
          </button>
        </div>
      )}
    </div>
  );
}
