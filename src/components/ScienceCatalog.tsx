import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SCIENCE_TEASER, parseCatalogResponse, type CatalogEntry, type CatalogResponse } from "../../shared/connector-catalog";
import { api, useStore } from "@/state/store";
import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { completeMcpSignIn, type McpSignInStatus } from "@/lib/mcp-sign-in";
import {
  allViewEntries, connectedEntries, entryServer, groupTitle, groupedEntries, matchesSearch, publicEntries, scienceSection, scienceServers, serverConnected,
  type ScienceServer,
} from "@/lib/science-catalog";
import { connectEntry, connectPublic, turnOff, type ConnectDeps } from "@/lib/science-connect";
import { AppsSection } from "./AppsSection";
import { GetMaxButton } from "./GetMaxButton";
import { ScienceTile, type TileState } from "./ScienceTile";
import { TILE_BUTTON_CLASS } from "./app-tile";

export interface ScienceConnection {
  id: string;
  name: string;
  domain: string;
}

interface Props {
  view: "science" | "all" | "connected" | "hidden";
  search: string;
  onViewAll(): void;
  onConnections(entries: ScienceConnection[]): void;
  onServersChanged(): void;
}

interface Local {
  busy: boolean;
  form: boolean;
  signIn: { status: McpSignInStatus; complete(result: McpSignInStatus): void } | null;
}

interface Served {
  revision: string | undefined;
  catalog: CatalogResponse;
}

let lastServed: Served | null = null;

export function forgetServedScience() {
  lastServed = null;
}

const IDLE: Local = { busy: false, form: false, signIn: null };
const INTRO_CLASS = "mb-3 flex items-center gap-4 rounded-xl px-4 py-3 text-[13px] bg-control/50 text-ink-secondary";
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function ScienceCatalog({ view, search, onViewAll, onConnections, onServersChanged }: Props) {
  const { state } = useStore();
  const revision = state.config?.science?.revision;
  const [served, setServed] = useState<Served | null>(lastServed);
  const [servers, setServers] = useState<ScienceServer[]>([]);
  const [local, setLocal] = useState<Record<string, Local>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState(false);
  const serversRef = useRef<ScienceServer[]>([]);
  const loads = useRef(0);
  const abort = useRef(new AbortController());
  const changed = useRef(onServersChanged);
  changed.current = onServersChanged;

  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const load = ++loads.current;
    void api("/api/connector-catalog").then((raw) => {
      const next = parseCatalogResponse(raw?.catalog);
      if (load !== loads.current) return;
      if (next && scienceSection(next)) {
        lastServed = { revision, catalog: next };
        setServed(lastServed);
      }
    }, () => {});
    void api("/api/mcp/servers").then((result) => {
      if (load !== loads.current) return;
      serversRef.current = scienceServers(result?.servers ?? []);
      setServers(serversRef.current);
    }, () => {});
  }, [revision]);

  const current = served && served.revision === revision ? served.catalog : null;
  const pending = current === null && served === null;
  const section = scienceSection(current ?? SCIENCE_TEASER);
  const connected = useMemo(() => (section ? connectedEntries(section, servers) : []), [section, servers]);
  const report = useRef(onConnections);
  report.current = onConnections;
  const connections = JSON.stringify(connected.map((e): ScienceConnection => ({ id: e.id, name: e.name, domain: e.domain })));
  useEffect(() => {
    report.current(JSON.parse(connections) as ScienceConnection[]);
  }, [connections]);

  const patch = useCallback((id: string, next: Partial<Local>) => setLocal((all) => ({ ...all, [id]: { ...(all[id] ?? IDLE), ...next } })), []);
  const fail = useCallback((id: string, error: string | null) => setErrors((all) => {
    const { [id]: _drop, ...rest } = all;
    return error ? { ...rest, [id]: error } : rest;
  }), []);

  const deps = useCallback((id: string | null): ConnectDeps => ({
    api,
    open: openExternalLink,
    signal: abort.current.signal,
    servers: () => serversRef.current,
    onServers: (listing) => {
      serversRef.current = scienceServers(listing);
      setServers(serversRef.current);
      changed.current();
    },
    onSignIn: (status, complete) => { if (id) patch(id, { signIn: status && complete ? { status, complete } : null }); },
  }), [patch]);

  const connect = async (entry: CatalogEntry, address?: string) => {
    fail(entry.id, null);
    patch(entry.id, { busy: true });
    const result = await connectEntry(entry, deps(entry.id), address);
    patch(entry.id, result.ok ? { ...IDLE } : { busy: false, signIn: null });
    if (!result.ok) fail(entry.id, result.error);
  };

  const toggleForm = (entry: CatalogEntry) => {
    fail(entry.id, null);
    patch(entry.id, { form: !(local[entry.id]?.form) });
  };

  const turnEntryOff = async (entry: CatalogEntry) => {
    const server = entryServer(entry, serversRef.current);
    if (!server) return;
    fail(entry.id, null);
    patch(entry.id, { busy: true });
    try {
      await turnOff(server, deps(entry.id));
    } catch (cause) {
      fail(entry.id, message(cause));
    } finally {
      patch(entry.id, { busy: false });
    }
  };

  const completeSignIn = async (entry: CatalogEntry, callbackUrl: string) => {
    const flow = local[entry.id]?.signIn;
    const server = entryServer(entry, serversRef.current);
    if (!flow?.status.flowId || !server) return;
    fail(entry.id, null);
    try {
      flow.complete(await completeMcpSignIn(server.name, flow.status.flowId, callbackUrl, api));
    } catch (cause) {
      fail(entry.id, message(cause));
    }
  };

  const continueSignIn = (entry: CatalogEntry) => {
    const url = local[entry.id]?.signIn?.status.authorizationUrl;
    if (url) void openExternalLink(url).catch(() => {});
  };

  const available = (entry: CatalogEntry) => !(entry.auth === "cloud" && !entry.url);
  const remaining = section ? publicEntries(section).filter((e) => available(e) && !serverConnected(entryServer(e, servers))) : [];

  const connectRemaining = async () => {
    setBulk(true);
    remaining.forEach((e) => fail(e.id, null));
    try {
      const results = await connectPublic(remaining, deps(null));
      for (const [id, result] of Object.entries(results)) if (!result.ok && result.error) fail(id, result.error);
    } finally {
      setBulk(false);
    }
  };

  if (view === "hidden" || !section || (pending && view !== "science")) return null;

  const renderTile = (entry: CatalogEntry) => {
    const own = local[entry.id] ?? IDLE;
    const server = entryServer(entry, servers);
    const isConnected = serverConnected(server);
    const busy = own.busy || (bulk && remaining.some((e) => e.id === entry.id));
    const tileState: TileState = busy ? (own.signIn ? "browser" : "working") : isConnected ? "connected" : own.form ? "tenant" : section.locked ? "locked" : "idle";
    const status = own.signIn?.status;
    return (
      <ScienceTile
        key={entry.id}
        entry={entry}
        state={tileState}
        needsMax={section.locked && !!server && entry.auth === "cloud"}
        unavailable={!available(entry) && !section.locked}
        showForm={entry.auth === "tenant" && own.form}
        signIn={status ? { authorizationUrl: status.authorizationUrl, pasteBack: status.pasteBack === true } : null}
        error={errors[entry.id] ?? null}
        onConnect={() => (entry.auth === "tenant" && !server ? toggleForm(entry) : void connect(entry))}
        onSubmitAddress={(address) => void connect(entry, address)}
        onContinue={() => continueSignIn(entry)}
        onComplete={(url) => completeSignIn(entry, url)}
        onTurnOff={() => void turnEntryOff(entry)}
      />
    );
  };

  const flat = (entries: CatalogEntry[], id: string, viewAll?: () => void) =>
    entries.length > 0 && (
      <div data-apps-grid="true" className="@container mb-7 flex flex-col gap-7 pt-1">
        <AppsSection id={id} title={t("apps.filter.science")} viewAll={viewAll ? { label: t("apps.viewAll"), onClick: viewAll } : undefined}>
          {entries.map(renderTile)}
        </AppsSection>
      </div>
    );

  if (view === "all") return flat(allViewEntries(section, search), "science-all", search.trim() ? undefined : onViewAll) || null;
  if (view === "connected") return flat(connected.filter((e) => matchesSearch(e, search)), "science-connected") || null;

  const groups = groupedEntries(section, search);
  const publicTotal = publicEntries(section).length;
  return (
    <>
      {!search.trim() && !pending && (
        <div className={INTRO_CLASS}>
          {section.locked ? (
            <>
              <span className="min-w-0 flex-1">{t("science.teaser")}</span>
              <GetMaxButton />
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1">{t("science.intro", { count: publicTotal })}</span>
              <button type="button" disabled={bulk || remaining.length === 0} onClick={() => void connectRemaining()} className={TILE_BUTTON_CLASS}>
                {remaining.length === 0 ? t("science.publicConnected") : remaining.length === 1 ? t("science.connectPublicOne") : t("science.connectPublic", { count: remaining.length })}
              </button>
            </>
          )}
        </div>
      )}
      <div data-apps-grid="true" className="@container flex flex-col gap-7 pt-1">
        {groups.map(({ group, entries }) => (
          <AppsSection key={group.id} id={`science-${group.id}`} title={groupTitle(group)}>
            {entries.map(renderTile)}
          </AppsSection>
        ))}
        {groups.length === 0 && <p className="px-2 text-[13px] text-ink-secondary">{t("science.noMatch")}</p>}
      </div>
    </>
  );
}
