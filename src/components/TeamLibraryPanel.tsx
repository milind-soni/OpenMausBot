import { track } from "@/lib/analytics";
import { t } from "@/lib/i18n";
import { addTemplate } from "@/lib/template-add";
import { templateDetailsOf } from "@/lib/template-details";
import { orgCardAction, orgPackagePreview, type OrgLibraryListing, type OrgLibraryPackage } from "@/lib/org-library";
import type { PackageDocument } from "../../shared/package-format";
import { COMMUNITY_REPOSITORY_URL, type TemplateDetails } from "../../shared/share-card";
import type { Routine } from "@/lib/routines";
import { openExternalLink } from "@/lib/app-links";
import { api, useStore, type Bot, type Group } from "@/state/store";
import { ArrowLeft, Check, ExternalLink, Github, Loader2, Search, Users, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { catalogCopy, catalogMatches, type TeamCatalog, type TeamCatalogEntry } from "@/lib/team-catalog";

import { ReadyBotGallery } from "./ReadyBotGallery";
import { OrgLibraryTab } from "./TeamLibraryPanelOrg";
import { TemplateDetailsBody } from "./TemplateCard";

export interface TeamImportResult {
  name: string;
  members: number;
  presets?: number;
  connections?: number;
}

/** What the preview is of: a community team (its file, added as a file) or a package from the organization's library. */
type Pending = { details: TemplateDetails; manifest: unknown; org?: undefined } | { details: TemplateDetails; manifest?: undefined; org: OrgLibraryPackage };

function TeamGlyph() {
  return (
    <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-ink/[0.06] text-ink-secondary">
      <Users size={20} />
    </div>
  );
}

/** Templates: one gallery of ready-made bots, the organization's library and the community teams. Import and Share
 * live elsewhere ("+" → Import…, a department's Share). */
export function TeamLibraryPanel({
  onClose,
  onImported,
  returnFocusRef,
}: {
  onClose: () => void;
  onImported: (result: TeamImportResult) => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [nestedDialog, setNestedDialog] = useState(false);
  const [orgListing, setOrgListing] = useState<OrgLibraryListing | null>(null);
  const [orgBusy, setOrgBusy] = useState<string | null>(null);
  const [orgNotice, setOrgNotice] = useState("");
  const [orgError, setOrgError] = useState("");

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError("");
    try {
      // SAFETY: this endpoint is owned by the app and returns TeamCatalog.
      setCatalog((await api("/api/team-library/catalog")) as TeamCatalog);
    } catch (cause) {
      setCatalogError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const loadOrgLibrary = useCallback(async () => {
    try {
      // SAFETY: this endpoint is owned by the app and returns OrgLibraryListing.
      setOrgListing((await api("/api/org-library")) as OrgLibraryListing);
    } catch {
      setOrgListing({ organization: null, packages: [] });
    }
  }, []);

  useEffect(() => {
    void loadOrgLibrary();
  }, [loadOrgLibrary]);

  useEffect(() => {
    dialogRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, [returnFocusRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (nestedDialog) return;
      if (event.key === "Escape" && !importing) {
        event.preventDefault();
        event.stopPropagation();
        if (pending) setPending(null);
        else onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const items = Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((item) => !item.closest("[hidden]"));
      if (!dialog || items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [importing, onClose, pending, nestedDialog]);

  const loadLibraryTeam = async (entry: TeamCatalogEntry) => {
    setBusySlug(entry.slug);
    setError("");
    try {
      const manifest: unknown = await api(`/api/team-library/teams/${entry.slug}`);
      setPending({ details: templateDetailsOf(manifest), manifest });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusySlug(null);
    }
  };

  const importTeam = async (manifest: unknown, name: string) => {
    setImporting(true);
    setError("");
    try {
      const response = await addTemplate(manifest, dispatch);
      track("team_imported", { members: response.bots.length, source: "library", mode: "add", format: "package" });
      onImported({
        name,
        members: response.bots.length,
        ...(response.connections?.length ? { connections: response.connections.length } : {}),
        ...(response.presets?.length ? { presets: response.presets.length } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };

  const loadOrgDetails = async (entry: OrgLibraryPackage) => {
    setOrgBusy(entry.packageId);
    setOrgError("");
    try {
      // SAFETY: this endpoint is owned by the app and returns the verified release.
      const preview = (await api(`/api/org-library/packages/${entry.packageId}`)) as { document: PackageDocument };
      setPending({ details: orgPackagePreview(preview.document), org: entry });
      setError("");
    } catch (cause) {
      setOrgError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOrgBusy(null);
    }
  };

  const addOrgPackage = async (entry: OrgLibraryPackage) => {
    setOrgBusy(entry.packageId);
    setImporting(true);
    setOrgError("");
    setOrgNotice("");
    setError("");
    try {
      // SAFETY: this endpoint is owned by the app and returns the added records.
      const response = (await api("/api/org-library/add", {
        method: "POST",
        body: JSON.stringify({ packageId: entry.packageId }),
      })) as { alreadyAdded: boolean; bots?: Bot[]; groups?: Group[]; routines?: Routine[]; connections?: unknown[] };
      for (const bot of response.bots ?? []) dispatch({ type: "botAdded", bot });
      for (const group of response.groups ?? []) dispatch({ type: "groupPatched", group });
      for (const routine of response.routines ?? []) dispatch({ type: "routinePatched", routine });
      const first = response.bots?.find((bot) => !bot.hidden);
      track("team_imported", { members: response.bots?.length ?? 0, source: "organization", mode: "add", format: "package" });
      if (first) {
        dispatch({ type: "select", id: first.id });
        onImported({
          name: entry.name,
          members: response.bots!.length,
          ...(response.connections?.length ? { connections: response.connections.length } : {}),
        });
        return;
      }
      setPending(null);
      if (!response.alreadyAdded) setOrgNotice(t("orgLibrary.addedSkills", { name: entry.name }));
      await loadOrgLibrary();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (pending?.org) setError(message);
      else setOrgError(message);
      await loadOrgLibrary();
    } finally {
      setOrgBusy(null);
      setImporting(false);
    }
  };

  const normalizedSearch = search.trim().toLowerCase();
  const visibleTeams = (catalog?.teams ?? []).filter((entry) => !normalizedSearch || catalogMatches(entry, normalizedSearch));
  const primary = "flex shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[14px] font-medium text-accent-ink hover:bg-accent/90 disabled:opacity-60";

  return createPortal(
    // Dim only: a full-window backdrop blur is redrawn every frame without a GPU and keeps the page laggy while it is open.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !importing && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-library-title"
        tabIndex={-1}
        className="animate-pop-in flex h-[min(780px,calc(100dvh-2rem))] w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-6 sm:px-8 sm:pt-7">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {pending && (
                <button
                  onClick={() => { setPending(null); setError(""); }}
                  disabled={importing}
                  className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                  aria-label={t("templates.back")}
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              <h2 id="team-library-title" className="truncate text-[20px] font-semibold tracking-[-0.01em] text-ink">
                {pending ? pending.details.name : t("templates.title")}
              </h2>
            </div>
            {!pending && <p className="mt-1 text-[13px] text-ink-secondary">{t("templates.subtitle")}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!pending && (
              <button
                onClick={() => void openExternalLink(catalog?.repositoryUrl || COMMUNITY_REPOSITORY_URL).catch(() => {})}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
                title={t("templates.openRepository")}
              >
                <Github size={16} />
                <span className="max-sm:hidden">{t("templates.communityRepo")}</span>
                <ExternalLink size={12} />
              </button>
            )}
            <button
              onClick={onClose}
              disabled={importing}
              className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
              aria-label={t("templates.close")}
            >
              <X size={21} />
            </button>
          </div>
        </header>

        {pending ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4 sm:px-8">
              <div className="max-w-2xl"><TemplateDetailsBody details={pending.details} /></div>
              {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>}
            </div>
            <footer className="flex items-center justify-end gap-3 border-t border-hairline/35 px-6 py-4 sm:px-8">
              {pending.org ? (
                orgCardAction(pending.org) === "add" ? (
                  <button onClick={() => void addOrgPackage(pending.org!)} disabled={importing} aria-label={t("orgLibrary.addAria", { name: pending.org.name })} className={primary}>
                    {importing && <Loader2 size={15} className="animate-spin" />}
                    {importing ? t("orgLibrary.adding") : t("orgLibrary.add")}
                  </button>
                ) : (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-raised px-4 py-2 text-[13px] text-ink-secondary">
                    <Check size={14} className="text-success" />{t("orgLibrary.added")}
                  </span>
                )
              ) : (
                <button onClick={() => void importTeam(pending.manifest, pending.details.name)} disabled={importing} className={primary}>
                  {importing && <Loader2 size={15} className="animate-spin" />}
                  {importing ? t("templates.importing") : t("templates.addTeam")}
                </button>
              )}
            </footer>
          </>
        ) : (
          <>
            <div className="px-6 pb-2 pt-3 sm:px-8">
              <label className="flex h-9 w-full items-center gap-2.5 rounded-lg bg-inset px-3 sm:w-[320px]">
                <Search size={16} className="shrink-0 text-ink-secondary" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("templates.search")}
                  aria-label={t("templates.search")}
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none"
                />
              </label>
            </div>
            <div data-template-gallery className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-4 sm:px-8">
              {orgListing?.organization && (
                <section className="mb-8" aria-label={t("orgLibrary.tab", { name: orgListing.organization.name })}>
                  <div className="mb-2 text-[12px] font-medium text-ink-tertiary">{t("orgLibrary.tab", { name: orgListing.organization.name })}</div>
                  <OrgLibraryTab
                    listing={orgListing as OrgLibraryListing & { organization: { id: string; name: string } }}
                    busy={orgBusy}
                    notice={orgNotice}
                    error={orgError}
                    onAdd={(entry) => void addOrgPackage(entry)}
                    onDetails={(entry) => void loadOrgDetails(entry)}
                  />
                </section>
              )}
              <ReadyBotGallery search={search} onDialog={setNestedDialog} onAdded={onClose} />
              <div className="mb-3 text-[12px] font-medium text-ink-tertiary">
                {search ? t("templates.searchResults") : t("templates.communityTemplates")}
              </div>
              {error && <div role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>}
              {catalogLoading && (
                <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary">
                  <Loader2 size={16} className="animate-spin" /> {t("templates.loading")}
                </div>
              )}
              {!catalogLoading && catalogError && (
                <div className="rounded-xl bg-danger/10 p-4 text-[13px] text-danger">
                  <p>{catalogError}</p>
                  <button onClick={() => void loadCatalog()} className="mt-3 rounded-full bg-raised px-3.5 py-2 text-ink hover:bg-raised-hover">{t("common.tryAgain")}</button>
                </div>
              )}
              {!catalogLoading && catalog && (
                <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
                  {visibleTeams.map((entry) => {
                    const copy = catalogCopy(entry);
                    return (
                      <article key={entry.slug} className="flex min-h-[104px] items-center gap-3 border-b border-hairline/35 px-1 py-4">
                        <TeamGlyph />
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-[13px] font-medium text-ink">{copy.name}</h3>
                          <p className="mt-0.5 truncate text-[13px] text-ink-secondary">{copy.outcome ?? copy.summary}</p>
                          <p className="mt-1 truncate text-[12px] text-ink-tertiary">
                            {t("templates.botCount", { count: entry.members })} · {t("templates.playbookCount", { count: entry.skills.length })}
                            {entry.requires.apps.length > 0 && ` · ${entry.requires.apps.join(", ")}`}
                            {entry.setupMinutes && ` · ${t("templates.minutes", { count: entry.setupMinutes })}`}
                          </p>
                        </div>
                        <button
                          onClick={() => void loadLibraryTeam(entry)}
                          disabled={busySlug !== null}
                          className="flex min-w-[72px] items-center justify-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
                        >
                          {busySlug === entry.slug && <Loader2 size={13} className="animate-spin" />}
                          {busySlug === entry.slug ? t("templates.loadingShort") : t("templates.load")}
                        </button>
                      </article>
                    );
                  })}
                </div>
              )}
              {!catalogLoading && catalog && visibleTeams.length === 0 && (
                <div className="flex min-h-56 flex-col items-center justify-center text-center">
                  <div className="text-[13px] font-medium text-ink">{t("templates.noneFound")}</div>
                  <div className="mt-1 text-[13px] text-ink-secondary">{t("templates.tryDifferentSearch")}</div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
