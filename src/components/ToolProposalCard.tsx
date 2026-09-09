// "I found something that would do this." — rungs 3 and 4 of the tool ladder.
//
// The bot went looking and came back with a real package, or found nothing and
// built one. Either way this card is the only thing standing between that and
// code running on the user's computer,
// so it is built to be READ rather than clicked past:
//
//   - the exact command, in monospace, never summarised
//   - who publishes it, marked unverified, because we did not check
//   - the pages the bot actually read, as links the user can open
//   - a consent line that names what approving does, not what it is called
//
// Approve echoes the hash of what was displayed. A proposal that changed
// since cannot be approved by a click on the old one.
import { useState } from "react";
import { ArrowUpRight, Check, Loader2, ShieldAlert, X } from "lucide-react";

import { api, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { consequenceLine, reviewedProposalSha256 } from "../../shared/tool-proposal";

export function ToolProposalCard({ threadId, message }: { threadId: string; message: Message }) {
  const card = message.card;
  const proposal = card?.toolProposal;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!card || !proposal) return null;

  const endpoint = `/api/threads/${encodeURIComponent(threadId)}/tool-proposals/${encodeURIComponent(message.id)}`;
  const reviewed = reviewedProposalSha256(proposal);
  const decide = async (action: "approve" | "decline") => {
    setBusy(true);
    setError(null);
    try {
      await api(`${endpoint}/${action}`, {
        method: "POST",
        body: JSON.stringify(action === "approve" ? { reviewedSha256: reviewed } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const settled = proposal.settled;
  const runs = [proposal.command, ...proposal.args].join(" ");

  return (
    <div
      className={`w-full max-w-[560px] rounded-2xl border bg-card p-4 ${
        settled ? "border-hairline/30 opacity-70" : "border-warning/40"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[15px] font-semibold text-ink">{proposal.label}</div>
        <span className="shrink-0 rounded-full bg-control px-2 py-0.5 text-[11px] text-ink-secondary">
          {proposal.kind === "mcp"
            ? t("proposal.kind.mcp")
            : proposal.kind === "generated"
              ? t("proposal.kind.generated")
              : t("proposal.kind.cli")}
        </span>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{proposal.summary}</p>

      <dl className="mt-3 space-y-1.5 text-[12.5px]">
        {/* A generated tool has no package and no publisher; what it was
            built FROM is its provenance, and the user can open that. */}
        {proposal.builtFrom ? (
          <Row label={t("proposal.builtFrom")}>
            <a href={proposal.builtFrom} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
              {proposal.builtFrom}
            </a>
          </Row>
        ) : (
          <Row label={t("proposal.package")}>
            <span className="font-mono text-ink">{proposal.packageId}@{proposal.packageVersion}</span>
          </Row>
        )}
        {proposal.publisher && (
          <Row label={t("proposal.publisher")}>
            {/* said by the page the bot read, not checked by us — and the card
                has to admit that rather than lend it our credibility */}
            <span className="text-ink">{proposal.publisher}</span>
            <span className="ml-1.5 text-ink-secondary">{t("proposal.unverified")}</span>
          </Row>
        )}
        {proposal.envNames?.length ? (
          <Row label={t("proposal.reads")}>
            <span className="font-mono text-ink">{proposal.envNames.join(", ")}</span>
          </Row>
        ) : null}
      </dl>

      <div className="mt-2.5">
        <div className="text-[11.5px] uppercase tracking-[0.14em] text-ink-secondary">{t("proposal.runs")}</div>
        <pre
          tabIndex={0}
          className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink"
        >
          {runs}
        </pre>
      </div>

      <div className="mt-2.5" hidden={proposal.sources.length === 0}>
        <div className="text-[11.5px] uppercase tracking-[0.14em] text-ink-secondary">{t("proposal.sources")}</div>
        <ul className="mt-1 space-y-0.5">
          {proposal.sources.map((source) => (
            <li key={source.url}>
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline"
              >
                <span className="truncate">{source.url}</span>
                <ArrowUpRight size={11} className="shrink-0" />
              </a>
              {source.note && <span className="ml-1.5 text-[12px] text-ink-secondary">{source.note}</span>}
            </li>
          ))}
        </ul>
      </div>

      {!settled && (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] leading-snug text-warning">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            {consequenceLine(proposal)} {t("proposal.notChecked")}
          </span>
        </div>
      )}

      {error && <p className="mt-2 text-[12.5px] text-danger">{error}</p>}

      {settled ? (
        <div className="mt-3 flex items-center gap-1.5 text-[13px] text-ink-secondary">
          {settled === "approved" ? <Check size={14} className="text-success" /> : <X size={14} />}
          {settled === "approved" ? t("proposal.settled.approved") : t("proposal.settled.declined")}
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            onClick={() => void decide("decline")}
            disabled={busy}
            className="rounded-full px-3.5 py-1.5 text-[13.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
          >
            {t("proposal.decline")}
          </button>
          <button
            onClick={() => void decide("approve")}
            /* a card too old to carry a hash of what it showed is decline-only */
            disabled={busy || !reviewed}
            title={reviewed ? undefined : t("proposal.cannotApprove")}
            className="flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[13.5px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {t("proposal.approve")}
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-[86px] shrink-0 text-ink-secondary">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}
