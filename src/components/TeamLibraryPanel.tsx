import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { teamImportPreview, type PendingTeamImport } from "@/lib/team-import";
import { addTemplate } from "@/lib/template-add";
import { orgCardAction, orgPackagePreview, type OrgLibraryListing, type OrgLibraryPackage } from "@/lib/org-library";
import type { PackageDocument } from "../../shared/package-format";
import type { Routine } from "@/lib/routines";
import { api, useStore, type Bot, type Group } from "@/state/store";
import { ArrowLeft, Check, Compass, ExternalLink, FolderOpen, Github, Loader2, Search, Share2, UploadCloud, Users, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { catalogCopy, catalogMatches, type TeamCatalog, type TeamCatalogEntry } from "@/lib/team-catalog";

import { GrokFinishSetup, grokSetupLeft } from "./GrokFinishSetup";
import { TEAM_GLYPHS, TeamImportDetails } from "./TeamImportDetails";
import { GrokImportFlow } from "./GrokImportFlow";
import { ReadyBotGallery } from "./ReadyBotGallery";
import { ShareTeamDialog } from "./ShareTeamDialog";
import { OrgLibraryTab } from "./TeamLibraryPanelOrg";
import { MAX_TEAM_BACKUP_BYTES } from "../../shared/team-backup";
import { takeImportName } from "../../shared/import-name";
import { isGrokLink } from "../../shared/grok-import";
const COMMUNITY_TEAMS_REPOSITORY = "https://github.com/milind-soni/openmausbot-teams";

export { TeamImportDetails };

export interface TeamImportResult {
  name: string;
  members: number;
  presets?: number;
  connections?: number;
}

type ImportSource = "library" | "file" | "github" | "grok";
type TeamTab = "org" | "explore" | "import" | "scout" | "share";

interface ScoutResult {
  profile: { name: string; summary: string; stacks: string[] };
  suggestion: {
    roomName: string;
    manifest: {
      team: { members: Array<{ key: string; name: string; title: string; description: string; appearance: { color: string } }> };
    };
    reasons: Record<string, string>;
  };
}

interface DirectoryCandidate {
  slug: string;
  name: string;
  category: string;
  integrations: string[];
  prompt: string;
  detailUrl: string;
  matched: string[];
}

const DIRECTORY_COLORS = ["cyan", "red", "purple", "green", "orange"] as const;

async function openExternal(url: string): Promise<void> {
  if (window.ogb?.openExternal) {
    await window.ogb.openExternal(url);
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
}

export function shareableTeamList(sections: readonly string[], bots: ReadonlyArray<Pick<Bot, "section" | "hidden">>): Array<{ name: string; bots: number }> {
  const counts = new Map<string, number>();
  for (const bot of bots) {
    if (bot.hidden) continue;
    const team = bot.section?.trim() ?? "";
    counts.set(team, (counts.get(team) ?? 0) + 1);
  }
  const order = [...new Set([...sections.map((section) => section.trim()).filter(Boolean), ...counts.keys()])]
    .filter((name) => name !== "");
  return [...order, ""].flatMap((name) => (counts.get(name) ? [{ name, bots: counts.get(name)! }] : []));
}

function TeamGlyph({ index }: { index: number }) {
  return (
    <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl", TEAM_GLYPHS[index % TEAM_GLYPHS.length])}>
      <Users size={20} />
    </div>
  );
}

export function TeamLibraryPanel({
  onClose,
  onImported,
  returnFocusRef,
  initialUrl,
}: {
  onClose: () => void;
  onImported: (result: TeamImportResult) => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  initialUrl?: string;
}) {
  const { state, dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<TeamTab>("explore");
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTeamImport | null>(null);
  const [source, setSource] = useState<ImportSource>("file");
  const [githubUrl, setGithubUrl] = useState("");
  const [githubLoading, setGithubLoading] = useState(false);
  const [grokLink, setGrokLink] = useState<string | null>(null);
  const [finishing, setFinishing] = useState<{ notes: NonNullable<PendingTeamImport["grokSetup"]>; bot: Bot; result: TeamImportResult } | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [scoutFolder, setScoutFolder] = useState("");
  const [scouting, setScouting] = useState(false);
  const [scouted, setScouted] = useState<ScoutResult | null>(null);
  // The folder the current result was read from: the import pins the room to this, never to the input's current value.
  const [scoutedFolder, setScoutedFolder] = useState("");
  const [directory, setDirectory] = useState<DirectoryCandidate[] | null>(null);
  const [pickedDirectory, setPickedDirectory] = useState<Set<string>>(new Set());
  const [roomName, setRoomName] = useState("");
  const [creating, setCreating] = useState(false);
  const [sharing, setSharing] = useState<string | null>(null);
  const [nestedDialog, setNestedDialog] = useState(false);
  const [orgListing, setOrgListing] = useState<OrgLibraryListing | null>(null);
  const [orgBusy, setOrgBusy] = useState<string | null>(null);
  const [orgNotice, setOrgNotice] = useState("");
  const [orgError, setOrgError] = useState("");
  const [pendingOrg, setPendingOrg] = useState<OrgLibraryPackage | null>(null);
  const tabChosen = useRef(false);
  // Monotonic scout token: a late response from an older scout must never overwrite a newer one's state.
  const scoutRequest = useRef(0);

  const currentBotCount = state.bots.filter((bot) => !bot.hidden).length;
  const shareableTeams = shareableTeamList(state.sections ?? [], state.bots);
  const takenNames = new Set(state.bots.map((bot) => bot.name.trim().toLowerCase()));
  const importedNames = pending?.members.map((member) => takeImportName(member.name, takenNames)) ?? [];

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
      const listing = (await api("/api/org-library")) as OrgLibraryListing;
      setOrgListing(listing);
      if (listing.organization && !tabChosen.current) setTab("org");
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
      if (sharing !== null || nestedDialog) return;
      if (event.key === "Escape" && !importing) {
        event.preventDefault();
        event.stopPropagation();
        if (pending) {
          setPending(null);
          setPendingOrg(null);
        } else onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const items = Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
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
  }, [importing, onClose, pending, sharing, nestedDialog]);

  const previewManifest = (preview: PendingTeamImport, nextSource: ImportSource) => {
    setPending(preview);
    setSource(nextSource);
    setError("");
  };

  const readFile = async (file: File) => {
    if (file.size > MAX_TEAM_BACKUP_BYTES) throw new Error(t("templates.fileTooLarge"));
    const raw = await file.text();
    let manifest: unknown = raw;
    if (!file.name.toLowerCase().endsWith(".md")) {
      try {
        manifest = JSON.parse(raw);
      } catch (cause) {
        if (cause instanceof SyntaxError) throw new Error("That backup or team file is not valid JSON.");
        throw cause;
      }
    }
    previewManifest(teamImportPreview(manifest), "file");
  };

  const loadLibraryTeam = async (entry: TeamCatalogEntry) => {
    setBusySlug(entry.slug);
    setError("");
    try {
      previewManifest(teamImportPreview(await api(`/api/team-library/teams/${entry.slug}`)), "library");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusySlug(null);
    }
  };

  const loadGithubTeam = async () => {
    await loadGithubUrl(githubUrl);
  };

  const loadGithubUrl = async (requestedUrl: string) => {
    if (!requestedUrl.trim()) return;
    if (isGrokLink(requestedUrl)) return setGrokLink(requestedUrl.trim());
    setGithubLoading(true);
    setError("");
    try {
      const manifest = await api("/api/team-library/github", {
        method: "POST",
        body: JSON.stringify({ url: requestedUrl.trim() }),
      });
      previewManifest(teamImportPreview(manifest), "github");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubLoading(false);
    }
  };

  useEffect(() => {
    if (!initialUrl) return;
    tabChosen.current = true;
    setTab("import");
    setGithubUrl(initialUrl);
    void loadGithubUrl(initialUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl]);

  const importTeam = async () => {
    if (!pending) return;
    setImporting(true);
    setError("");
    try {
      const response = await addTemplate(pending.manifest, dispatch);
      const { first } = response;
      track("team_imported", { members: response.bots.length, source, mode: "add", format: pending.kind });
      const result = {
        name: pending.name,
        members: response.bots.length,
        ...(response.connections?.length ? { connections: response.connections.length } : {}),
        ...(response.presets?.length ? { presets: response.presets.length } : {}),
      };
      // A Grok Bot with apps to connect or routines left out: offer the Chief of Staff's help before closing.
      if (grokSetupLeft(pending.grokSetup) && first) setFinishing({ notes: pending.grokSetup, bot: first, result });
      else onImported(result);
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
      setPending(orgPackagePreview(preview.document));
      setPendingOrg(entry);
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
      setPendingOrg(null);
      if (!response.alreadyAdded) setOrgNotice(t("orgLibrary.addedSkills", { name: entry.name }));
      await loadOrgLibrary();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (pendingOrg) setError(message);
      else setOrgError(message);
      await loadOrgLibrary();
    } finally {
      setOrgBusy(null);
      setImporting(false);
    }
  };

  const scoutTarget = scoutFolder.trim();

  const runScout = async (folder: string) => {
    const request = ++scoutRequest.current;
    setScouting(true);
    setError("");
    setScouted(null);
    setDirectory(null);
    setPickedDirectory(new Set());
    try {
      // SAFETY: this endpoint is owned by the app and returns ScoutResult.
      const result = (await api(`/api/teams/scout?cwd=${encodeURIComponent(folder)}`)) as ScoutResult;
      if (request !== scoutRequest.current) return;
      setScouted(result);
      setScoutedFolder(folder);
      setRoomName(result.suggestion.roomName);
      track("team_scouted", { signals: result.suggestion.manifest.team.members.length - 1 });
      void api(`/api/teams/scout/directory?cwd=${encodeURIComponent(folder)}`)
        // SAFETY: this endpoint is owned by the app and returns candidates.
        .then((extra) => {
          if (request === scoutRequest.current) setDirectory((extra as { directory: DirectoryCandidate[] }).directory);
        })
        .catch(() => {
          if (request === scoutRequest.current) setDirectory([]);
        });
    } catch (cause) {
      if (request !== scoutRequest.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === scoutRequest.current) setScouting(false);
    }
  };

  const pickScoutFolder = async () => {
    const chosen = await window.ogb?.pickFolder?.(scoutTarget || undefined);
    if (!chosen) return;
    setScoutFolder(chosen);
    await runScout(chosen);
  };

  const createProject = async () => {
    if (!scouted || creating) return;
    setCreating(true);
    setError("");
    try {
      // Security: community bots join as ordinary manifest members, so the import boundary (persona only, no grants)
      // applies.
      const extras = (directory ?? [])
        .filter((candidate) => pickedDirectory.has(candidate.slug))
        .map((candidate, index) => ({
          key: `dir-${candidate.slug}`,
          name: candidate.name,
          title: candidate.category || t("templates.communityBot"),
          description: candidate.prompt,
          appearance: { color: DIRECTORY_COLORS[index % DIRECTORY_COLORS.length] },
        }));
      const manifest = {
        ...scouted.suggestion.manifest,
        team: {
          ...scouted.suggestion.manifest.team,
          members: [...scouted.suggestion.manifest.team.members, ...extras],
        },
      };
      const room = roomName.trim() || scouted.suggestion.roomName;
      // SAFETY: this endpoint is owned by the app and returns imported bots.
      const response = (await api(
        `/api/teams/import?mode=project&cwd=${encodeURIComponent(scoutedFolder)}&room=${encodeURIComponent(room)}`,
        { method: "POST", body: JSON.stringify(manifest) },
      )) as { bots: Bot[]; group?: Group };
      for (const bot of response.bots) dispatch({ type: "botAdded", bot });
      if (response.group) {
        dispatch({ type: "groupPatched", group: { ...response.group, messages: [] } });
        dispatch({ type: "select", id: response.group.id });
      }
      track("team_imported", { members: response.bots.length, source: "scout", mode: "project" });
      onImported({
        name: room,
        members: response.bots.length,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const normalizedSearch = search.trim().toLowerCase();
  const visibleTeams = (catalog?.teams ?? []).filter((entry) => !normalizedSearch || catalogMatches(entry, normalizedSearch));

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
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
              {pending && !finishing && (
                <button
                  onClick={() => {
                    setPending(null);
                    setPendingOrg(null);
                    setError("");
                  }}
                  disabled={importing}
                  className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                  aria-label={t("templates.back")}
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              <h2 id="team-library-title" className="truncate text-[22px] font-semibold tracking-[-0.01em] text-ink">
                {pending ? pending.name : t("templates.title")}
              </h2>
            </div>
            <p className={cn("mt-1 text-[13px] text-ink-secondary", pending && "ml-9")}>
                {pending
                  ? pending.kind === "backup"
                    ? t("templates.backupSummary", { bots: pending.members.length, conversations: pending.conversations ?? 0 })
                    : pending.kind === "package"
                    ? pending.library
                      ? t("teamImport.library")
                      : pending.version === 2
                      ? t("teamImport.sharedTeam", { count: pending.members.length })
                      : t("templates.playbookSummary", { count: pending.members.length })
                    : t("templates.readyBots", { count: pending.members.length })
                  : t("templates.subtitle")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!pending && (
              <button
                onClick={() => void openExternal(catalog?.repositoryUrl ?? COMMUNITY_TEAMS_REPOSITORY)}
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

        {finishing ? <GrokFinishSetup notes={finishing.notes} imported={finishing.bot} onDone={() => onImported(finishing.result)} /> : pending ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-6 sm:px-8">
              <TeamImportDetails pending={pending} importedNames={importedNames} org={pendingOrg !== null} />
              {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>}
            </div>

            <footer className="flex flex-col gap-3 border-t border-hairline/35 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <div className="text-[13px] text-ink-secondary">
                {t(currentBotCount === 0 ? "templates.existingNone" : currentBotCount === 1 ? "templates.existingOne" : "templates.existingMany", { count: currentBotCount })}
                {" "}{pending.kind === "backup"
                  ? t("teamImport.backupCopies")
                  : pending.library
                  ? t("teamImport.libraryAdds")
                  : pending.members.length === 0
                  ? ""
                  : t("teamImport.newSection", { name: pending.teamName ?? pending.name })}
              </div>
              {pendingOrg ? (
                orgCardAction(pendingOrg) === "add" ? (
                  <button
                    onClick={() => void addOrgPackage(pendingOrg)}
                    disabled={importing}
                    aria-label={t("orgLibrary.addAria", { name: pendingOrg.name })}
                    className="flex shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[14px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
                  >
                    {importing && <Loader2 size={15} className="animate-spin" />}
                    {importing ? t("orgLibrary.adding") : t("orgLibrary.add")}
                  </button>
                ) : (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-raised px-4 py-2 text-[13px] text-ink-secondary">
                    <Check size={14} className="text-success" />{t("orgLibrary.added")}
                  </span>
                )
              ) : <button
                onClick={() => void importTeam()}
                disabled={importing}
                className="flex shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[14px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
              >
                {importing && <Loader2 size={15} className="animate-spin" />}
                {importing
                  ? t("templates.importing")
                  : pending.kind === "backup" ? t("templates.importBackup") : pending.library ? t("teamImport.addPresets") : t("templates.addTeam")}
              </button>}
            </footer>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-3 px-6 pb-4 pt-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <div className="flex w-fit rounded-xl bg-raised/70 p-1" role="tablist" aria-label={t("templates.source") }>
                {orgListing?.organization && (
                  <button
                    role="tab"
                    aria-selected={tab === "org"}
                    onClick={() => {
                      tabChosen.current = true;
                      setTab("org");
                      setError("");
                    }}
                    className={cn(
                      "max-w-[220px] truncate rounded-lg px-4 py-2 text-[14px] transition-colors",
                      tab === "org" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                    )}
                  >
                    {t("orgLibrary.tab", { name: orgListing.organization.name })}
                  </button>
                )}
                <button
                  role="tab"
                  aria-selected={tab === "explore"}
                  onClick={() => {
                    tabChosen.current = true;
                    setTab("explore");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[14px] transition-colors",
                    tab === "explore" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {t("templates.explore")}
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "import"}
                  onClick={() => {
                    tabChosen.current = true;
                    setTab("import");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[14px] transition-colors",
                    tab === "import" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {t("templates.import")}
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "scout"}
                  onClick={() => {
                    tabChosen.current = true;
                    setTab("scout");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[14px] transition-colors",
                    tab === "scout" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {t("templates.fromFolder")}
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "share"}
                  onClick={() => {
                    tabChosen.current = true;
                    setTab("share");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[14px] transition-colors",
                    tab === "share" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {t("teamLibrary.shareTab")}
                </button>
              </div>
              {tab === "explore" && (
                <label className="flex h-11 w-full items-center gap-2.5 rounded-xl bg-raised/70 px-3.5 sm:w-[320px]">
                  <Search size={17} className="shrink-0 text-ink-secondary" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t("templates.search")}
                    aria-label={t("templates.search")}
                    className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
                  />
                </label>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5 sm:px-8">
              {tab === "org" && orgListing?.organization && (
                <OrgLibraryTab
                  listing={orgListing as OrgLibraryListing & { organization: { id: string; name: string } }}
                  busy={orgBusy}
                  notice={orgNotice}
                  error={orgError}
                  onAdd={(entry) => void addOrgPackage(entry)}
                  onDetails={(entry) => void loadOrgDetails(entry)}
                />
              )}
              {tab === "explore" && (
                <div>
                  <ReadyBotGallery search={search} onDialog={setNestedDialog} onAdded={onClose} />
                  <div className="mb-3 text-[12px] font-medium text-ink-secondary">
                    {search ? t("templates.searchResults") : t("templates.communityTemplates")}
                  </div>
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
                      {visibleTeams.map((entry, index) => {
                        const copy = catalogCopy(entry);
                        return (
                        <article key={entry.slug} className="flex min-h-[104px] items-center gap-3 border-b border-hairline/35 px-1 py-4">
                          <TeamGlyph index={index} />
                          <div className="min-w-0 flex-1">
                            <h3 className="truncate text-[14px] font-medium text-ink">{copy.name}</h3>
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
                      <div className="text-[14px] font-medium text-ink">{t("templates.noneFound")}</div>
                      <div className="mt-1 text-[13px] text-ink-secondary">{t("templates.tryDifferentSearch")}</div>
                    </div>
                  )}
                </div>
              )}

              {tab === "import" && (
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".md,.json,.mausbackup.json,.mausteam.json,text/markdown,application/json"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (!file) return;
                      void readFile(file).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                    }}
                  />
                  <div className="mb-3 text-[12px] font-medium text-ink-secondary">{t("templates.bringYourOwn")}</div>
                  <div className="grid gap-5 md:grid-cols-2">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        setDragging(true);
                      }}
                      onDragOver={(event) => event.preventDefault()}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragging(false);
                        const file = event.dataTransfer.files[0];
                        if (file) void readFile(file).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                      }}
                      className={cn(
                        "flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed px-6 text-center transition-colors",
                        dragging ? "border-accent bg-accent/5" : "border-hairline/60 bg-raised/20 hover:bg-raised/35",
                      )}
                    >
                      <UploadCloud size={27} className="text-accent" />
                      <span className="mt-3 text-[14px] font-medium text-ink">{t("templates.chooseFile")}</span>
                      <span className="mt-1 text-[13px] text-ink-secondary">{t("templates.dropFile")}</span>
                    </button>

                    <div className="flex min-h-56 flex-col justify-center rounded-2xl bg-raised/25 px-6">
                      <Github size={25} className="text-ink-secondary" />
                      <h3 className="mt-3 text-[14px] font-medium text-ink">{t("templates.loadGithub")}</h3>
                      <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("templates.githubHint")}</p>
                      <div className="mt-4 flex gap-2">
                        <input
                          value={githubUrl}
                          onChange={(event) => setGithubUrl(event.target.value)}
                          onKeyDown={(event) => event.key === "Enter" && void loadGithubTeam()}
                          placeholder={t("templates.githubPlaceholder")}
                          aria-label={t("templates.githubUrl")}
                          className="min-w-0 flex-1 rounded-xl bg-raised/80 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                        />
                        <button
                          onClick={() => void loadGithubTeam()}
                          disabled={!githubUrl.trim() || githubLoading}
                          className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
                        >
                          {githubLoading && <Loader2 size={13} className="animate-spin" />}
                          {t("templates.load")}
                        </button>
                      </div>
                    </div>
                  </div>
                  <GrokImportFlow link={grokLink} onPreview={(preview) => { setGrokLink(null); previewManifest(preview, "grok"); }} />
                  {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>}
                </div>
              )}

              {tab === "share" && (
                <div>
                  <p className="max-w-2xl text-[13px] leading-relaxed text-ink-secondary">{t("teamLibrary.shareIntro")}</p>
                  {shareableTeams.length === 0 ? (
                    <p className="mt-6 text-[13px] text-ink-secondary">{t("teamLibrary.shareEmpty")}</p>
                  ) : (
                    <div className="mt-4 grid grid-cols-1 gap-x-10 md:grid-cols-2">
                      {shareableTeams.map((team, index) => (
                        <article key={team.name || "general"} className="flex min-h-[84px] items-center gap-3 border-b border-hairline/35 px-1 py-4">
                          <TeamGlyph index={index} />
                          <div className="min-w-0 flex-1">
                            <h3 className="truncate text-[14px] font-medium text-ink">{team.name || t("teamLibrary.general")}</h3>
                            <p className="mt-0.5 text-[13px] text-ink-secondary">{t("teamLibrary.shareBots", { count: team.bots })}</p>
                          </div>
                          <button
                            onClick={() => setSharing(team.name)}
                            aria-label={t("teamLibrary.shareTeamAria", { name: team.name || t("teamLibrary.general") })}
                            className="flex items-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[13px] text-ink hover:bg-raised-hover"
                          >
                            <Share2 size={13} />
                            {t("teamLibrary.shareTeam")}
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {tab === "scout" && (
                <div>
                  <div className="mb-3 text-[12px] font-medium text-ink-secondary">{t("templates.startFolder")}</div>
                  <p className="max-w-2xl text-[13px] leading-relaxed text-ink-secondary">
                    {t("templates.scoutHint")}
                  </p>
                  <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                    <input
                      value={scoutFolder}
                      onChange={(event) => setScoutFolder(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && scoutTarget && void runScout(scoutTarget)}
                      placeholder="/path/to/your/project"
                      aria-label={t("templates.projectFolder")}
                      className="min-w-0 flex-1 rounded-xl bg-raised/80 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                    />
                    {Boolean(window.ogb?.pickFolder) && (
                      <button
                        onClick={() => void pickScoutFolder()}
                        disabled={scouting}
                        className="flex items-center justify-center gap-1.5 rounded-full bg-raised px-4 py-2.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
                      >
                        <FolderOpen size={14} />
                        {t("templates.browse")}
                      </button>
                    )}
                    <button
                      onClick={() => void runScout(scoutTarget)}
                      disabled={!scoutTarget || scouting}
                      className="flex items-center justify-center gap-1.5 rounded-full bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
                    >
                      {scouting ? <Loader2 size={14} className="animate-spin" /> : <Compass size={14} />}
                      {scouting ? t("templates.scouting") : t("templates.scout")}
                    </button>
                  </div>

                  {scouted && (
                    <div className="mt-6">
                      <div className="rounded-2xl bg-raised/25 px-5 py-4">
                        <div className="text-[15px] font-semibold text-ink">{scouted.profile.name}</div>
                        {scouted.profile.summary && (
                          <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{scouted.profile.summary}</p>
                        )}
                        {scouted.profile.stacks.length > 0 && (
                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            {scouted.profile.stacks.map((stack) => (
                              <span key={stack} className="rounded-full bg-raised px-2.5 py-1 text-[12px] text-ink-secondary">
                                {stack}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="mt-5 text-[12px] font-medium text-ink-secondary">{t("templates.suggestedTeam")}</div>
                      <div className="mt-1 grid grid-cols-1 gap-x-10 md:grid-cols-2">
                        {scouted.suggestion.manifest.team.members.map((member, index) => (
                          <div key={member.key} className="flex min-h-[64px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                            <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold", TEAM_GLYPHS[index % TEAM_GLYPHS.length])}>
                              {member.name.slice(0, 1).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-[14px] font-medium text-ink">
                                {member.name} <span className="font-normal text-ink-secondary">· {member.title}</span>
                              </div>
                              <div className="mt-0.5 truncate text-[12px] text-ink-secondary">
                                {scouted.suggestion.reasons[member.key] ?? ""}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>

                      {directory && directory.length > 0 && (
                        <>
                          <div className="mt-5 text-[12px] font-medium text-ink-secondary">{t("templates.communityDirectory")}</div>
                          <div className="mt-1 flex flex-col">
                            {directory.map((candidate) => (
                              <div key={candidate.slug} className="flex items-center gap-3 border-b border-hairline/35 px-1 py-3">
                                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                                  <input
                                    type="checkbox"
                                    checked={pickedDirectory.has(candidate.slug)}
                                    onChange={() =>
                                      setPickedDirectory((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(candidate.slug)) next.delete(candidate.slug);
                                        else next.add(candidate.slug);
                                        return next;
                                      })
                                    }
                                    className="size-4 accent-accent"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[14px] font-medium text-ink">
                                      {candidate.name}
                                      {candidate.category && <span className="font-normal text-ink-secondary"> · {candidate.category}</span>}
                                    </div>
                                    <div className="mt-0.5 truncate text-[12px] text-ink-secondary">
                                      {t("templates.matches", { values: candidate.matched.join(", ") })}
                                    </div>
                                  </div>
                                </label>
                                <button
                                  onClick={() => void openExternal(candidate.detailUrl)}
                                  aria-label={t("templates.openDirectory", { name: candidate.name })}
                                  title={t("templates.readBeforeAdding")}
                                  className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
                                >
                                  <ExternalLink size={14} />
                                </button>
                              </div>
                            ))}
                          </div>
                        </>
                      )}

                      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                        <input
                          value={roomName}
                          onChange={(event) => setRoomName(event.target.value)}
                          aria-label={t("templates.groupChatName")}
                          className="min-w-0 flex-1 rounded-xl bg-raised/80 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                        />
                        <button
                          onClick={() => void createProject()}
                          disabled={creating}
                          className="flex shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[14px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
                        >
                          {creating && <Loader2 size={15} className="animate-spin" />}
                          {creating ? t("templates.creating") : t("templates.createGroupChat")}
                        </button>
                      </div>
                      <p className="mt-2 text-[12px] text-ink-secondary">
                        {t("templates.createGroupHint")}
                      </p>
                    </div>
                  )}
                  {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {sharing !== null && <ShareTeamDialog team={sharing} onClose={() => setSharing(null)} />}
    </div>,
    document.body,
  );
}
