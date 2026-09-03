// Installed browser extensions, in app settings.
//
// The shape follows the learned-skills card in SettingsPanel: an install
// lands disabled, turning it on opens a review dialog, and the person
// enables only after reading what the extension asked for. Extensions are a
// stronger case for that flow than skills — this is third-party code running
// inside every page a bot opens, in a session holding the person's logins.
//
// Two things this card must always be honest about, because Electron
// implements only part of the Chrome extension API:
//   - which bots an extension will affect (all of them: extensions load per
//     browser session, and named profiles are shared)
//   - which parts of an extension will simply not work here
// Both come from the server, which reads them out of the manifest at install.
import { useCallback, useEffect, useState } from "react";
import { Puzzle, Trash2 } from "lucide-react";

import { api, useStore } from "@/state/store";
import { builtInBrowserEnabled } from "@/lib/feature-flags";
import { Card, Switch } from "./SettingsPrimitives";

export interface BrowserExtensionListing {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  intact: boolean;
  manifestVersion: number;
  source: { type: "local"; path: string } | { type: "webstore"; url: string };
  permissions: string[];
  hostPermissions: string[];
  warnings: string[];
}

/** The one-line description of an extension's reach, shown in the row and
 * again in the review dialog. */
export function reachSummary(extension: Pick<BrowserExtensionListing, "hostPermissions">): string {
  const hosts = extension.hostPermissions;
  if (!hosts.length) return "no site access";
  if (hosts.some((pattern) => /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*)$/.test(pattern))) {
    return "runs on every page";
  }
  return hosts.length === 1 ? `runs on ${hosts[0]}` : `runs on ${hosts.length} site patterns`;
}

/** Extensions load per browser session, so an install reaches every bot that
 * browses. Naming them is the honest way to say so. */
export function affectedBotNames(bots: Array<{ name: string; hidden?: boolean }>): string[] {
  return bots.filter((bot) => !bot.hidden).map((bot) => bot.name);
}

export function BrowserExtensionsRow() {
  const { state } = useStore();
  const [extensions, setExtensions] = useState<BrowserExtensionListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState<{ extension: BrowserExtensionListing; manifest: string } | null>(null);
  const [storeInput, setStoreInput] = useState("");

  const refresh = useCallback(async () => {
    try {
      const result = await api("/api/browser-extensions") as { extensions?: BrowserExtensionListing[] };
      setExtensions(result.extensions ?? []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load browser extensions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Converge live browser sessions. The packaged server sends the same
   * request privately over its parent port; this is the split-process
   * development path, and both are idempotent. */
  const converge = async () => {
    try {
      await window.ogb?.browser?.syncExtensions?.();
    } catch {
      // The disk state is authoritative either way; a failed nudge only
      // means live sessions catch up on their next page load.
    }
  };

  const featureOn = builtInBrowserEnabled(state.config);
  // Keep the card reachable when the feature is off but extensions exist, so
  // a person can always switch off or remove something already installed.
  if (!window.ogb || (!featureOn && extensions.length === 0 && !loading)) return null;

  /** Every mutation here has the same shape: mark busy, clear the last
   * error, do the thing, report a failure in the caller's words, unmark. */
  const perform = async (key: string, failure: string, action: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    const folder = await window.ogb?.pickFolder?.(undefined, "Choose an unpacked extension folder");
    if (!folder) return;
    await perform("add", "Could not add that extension.", async () => {
      await api("/api/browser-extensions", { method: "POST", body: JSON.stringify({ path: folder }) });
      await converge();
      await refresh();
    });
  };

  const addFromStore = async () => {
    const url = storeInput.trim();
    if (!url) return;
    await perform("add", "Could not add that extension.", async () => {
      await api("/api/browser-extensions", { method: "POST", body: JSON.stringify({ url }) });
      setStoreInput("");
      await converge();
      await refresh();
    });
  };

  const openReview = (extension: BrowserExtensionListing) =>
    perform(extension.id, "Could not read that extension's manifest.", async () => {
      const result = await api(`/api/browser-extensions/${extension.id}/manifest`) as { text?: string };
      setReviewing({ extension, manifest: result.text ?? "" });
    });

  const setEnabled = (extension: BrowserExtensionListing, enabled: boolean) =>
    perform(extension.id, "Could not change that extension.", async () => {
      await api(`/api/browser-extensions/${extension.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      setReviewing(null);
      await converge();
      await refresh();
    });

  const remove = async (extension: BrowserExtensionListing) => {
    if (!window.confirm(`Remove “${extension.name}”? Its files are deleted and every bot stops using it.`)) return;
    await perform(extension.id, "Could not remove that extension.", async () => {
      await api(`/api/browser-extensions/${extension.id}`, { method: "DELETE" });
      await converge();
      await refresh();
    });
  };

  const affected = affectedBotNames(state.bots ?? []);

  return (
    <Card
      title="Browser extensions"
      subtitle="Unpacked Chrome extensions for the built-in browser. They run in every bot's browser, so add only what you trust. There is no extension toolbar here, so extensions built around a popup button will not work. Changes take effect the next time a page loads."
    >
      {loading ? (
        <div className="text-[13px] text-ink-secondary">Loading…</div>
      ) : extensions.length === 0 ? (
        <div className="text-[13px] text-ink-secondary">
          Nothing installed. Paste a Chrome Web Store link, or add an unpacked folder. Guest browsing never loads extensions.
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-hairline/30">
          {extensions.map((extension) => (
            <div key={extension.id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <Puzzle size={14} className="mt-0.5 shrink-0 text-ink-secondary" />
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium text-ink">
                    {extension.name} <span className="font-normal text-ink-secondary">{extension.version}</span>
                  </div>
                  <div className="truncate text-[12px] text-ink-secondary">{reachSummary(extension)}</div>
                  {extension.warnings.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {extension.warnings.map((warning) => (
                        <li key={warning} className="text-[11.5px] text-warning">{warning}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  checked={extension.enabled}
                  disabled={busy !== null || !extension.intact || (!extension.enabled && !featureOn)}
                  aria-label={`${extension.enabled ? "Disable" : "Enable"} ${extension.name}`}
                  onClick={() => {
                    if (extension.enabled) void setEnabled(extension, false);
                    else void openReview(extension);
                  }}
                />
                <button
                  type="button"
                  onClick={() => void remove(extension)}
                  disabled={busy !== null}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"
                  title="Remove this extension and delete its files"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void addFromStore();
        }}
      >
        <input
          value={storeInput}
          onChange={(event) => setStoreInput(event.target.value)}
          disabled={busy !== null || !featureOn}
          placeholder="Paste a Chrome Web Store link"
          aria-label="Chrome Web Store link or extension id"
          className="min-w-0 flex-1 rounded-lg bg-inset px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary outline-none disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={busy !== null || !featureOn || !storeInput.trim()}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40"
        >
          {busy === "add" ? "Adding…" : "Add"}
        </button>
      </form>

      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void add()}
          disabled={busy !== null || !featureOn || !window.ogb?.pickFolder}
          className="rounded-lg bg-control px-3 py-1.5 text-[13px] font-medium text-ink disabled:opacity-40"
        >
          Add unpacked folder…
        </button>
        {!featureOn && (
          <span className="text-[12px] text-ink-secondary">Turn on the built-in browser to add or enable extensions.</span>
        )}
      </div>

      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}

      {reviewing && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="extension-review-title"
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-6"
        >
          <div className="flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col rounded-2xl bg-card p-5 shadow-2xl">
            <div id="extension-review-title" className="text-[16px] font-semibold text-ink">
              Review {reviewing.extension.name} before enabling
            </div>
            <div className="mt-1 text-[11.5px] text-ink-secondary">
              Version {reviewing.extension.version} · Manifest V{reviewing.extension.manifestVersion} ·{" "}
              {reviewing.extension.source.type === "local" ? "from a folder" : "from the Chrome Web Store"}
            </div>

            <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] leading-relaxed text-ink">
              This extension runs inside every page any bot opens, in every browser profile, and can read and
              change what it finds there — including pages you are signed in to. Enable it only if you trust its
              author.
              {affected.length > 0 && (
                <span className="block mt-1 text-ink-secondary">
                  Affects: {affected.join(", ")}.
                </span>
              )}
            </div>

            {reviewing.extension.warnings.length > 0 && (
              <div className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] leading-relaxed text-warning">
                <div className="font-medium">What will not work in the built-in browser</div>
                <div className="mt-0.5 text-ink-secondary">
                  On a Cloud box the bot uses real Chrome, and none of these limits apply there.
                </div>
                <ul className="mt-1 list-disc pl-4">
                  {reviewing.extension.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-2 grid grid-cols-2 gap-3 text-[11.5px]">
              <div>
                <div className="font-medium text-ink">Permissions</div>
                <div className="mt-0.5 break-words text-ink-secondary">
                  {reviewing.extension.permissions.length ? reviewing.extension.permissions.join(", ") : "none"}
                </div>
              </div>
              <div>
                <div className="font-medium text-ink">Sites</div>
                <div className="mt-0.5 break-words text-ink-secondary">
                  {reviewing.extension.hostPermissions.length ? reviewing.extension.hostPermissions.join(", ") : "none"}
                </div>
              </div>
            </div>

            <pre
              tabIndex={0}
              aria-label={`Full manifest for ${reviewing.extension.name}`}
              className="mt-3 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink"
            >
              {reviewing.manifest}
            </pre>

            {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setReviewing(null)}
                className="rounded-lg px-4 py-2 text-[13px] font-medium text-ink-secondary hover:bg-raised disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void setEnabled(reviewing.extension, true)}
                className="rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                Enable reviewed extension
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
