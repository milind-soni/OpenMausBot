// App settings → People, on a hosted server: who may sign in to this
// workspace with an emailed code, their role, when they were last seen,
// what each person spent this month, and an invite link that opens the
// sign-in page with their address filled in. The link is convenience, not
// a second door: the one-time code still goes to the address itself.
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Link2, Loader2, Plus, RefreshCw } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { formatUsd, hasFiniteCost } from "@/lib/usage";
import { readSessionState, type SessionState } from "../lib/session";
import { canPairDevices } from "./ServerPairingCard";
import { normalizeAccessEntry, withEntry, withoutEntry, type SignInLists } from "./SignInAccessCard";
import { Card } from "./SettingsPrimitives";

export type Role = "admin" | "member";

export interface Person {
  entry: string;
  role: Role;
  /** `@domain`: everyone at a company, not one person. */
  isDomain: boolean;
  lastSeenAt: number | null;
  devices: number;
  turns: number;
  costUsd: number | null;
}

/** The sign-in page with the invited address filled in; a domain entry gets the plain page. */
export function inviteLink(base: string, entry: string): string {
  const origin = base.replace(/\/+$/, "");
  return entry.startsWith("@") ? `${origin}/pair` : `${origin}/pair?email=${encodeURIComponent(entry)}`;
}

/** One row per list entry, joined with the devices that signed in as that
 * address and the month's usage the ledger attributed to it. */
export function mergePeople(
  lists: SignInLists,
  sessions: Array<{ email?: string; lastSeenAt: number }>,
  usage: Array<{ key: string; turns: number; costUsd: number | null }>,
): Person[] {
  const people: Person[] = [];
  const seen = new Set<string>();
  const add = (entry: string, role: Role) => {
    const key = entry.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    const devices = sessions.filter((session) => session.email?.toLowerCase() === key);
    const month = usage.find((group) => group.key === `user:${key}`);
    people.push({
      entry: key,
      role,
      isDomain: key.startsWith("@"),
      lastSeenAt: devices.length ? Math.max(...devices.map((session) => session.lastSeenAt)) : null,
      devices: devices.length,
      turns: month?.turns ?? 0,
      costUsd: month?.costUsd ?? null,
    });
  };
  for (const entry of lists.admins) add(entry, "admin");
  for (const entry of lists.members) add(entry, "member");
  return people;
}

export function lastSeenLabel(lastSeenAt: number | null, now = Date.now()): string {
  if (lastSeenAt === null) return t("people.never");
  if (now - lastSeenAt < 24 * 60 * 60_000) return t("people.today");
  return new Date(lastSeenAt).toISOString().slice(0, 10);
}

/** The table alone, so it renders the same from a fetch or a fixture. */
export function PeopleTable({ people, busy, onRole, onRemove, onLink }: {
  people: Person[];
  busy: boolean;
  onRole: (person: Person, role: Role) => void;
  onRemove: (person: Person) => void;
  onLink: (person: Person) => void;
}) {
  if (people.length === 0) return <p className="text-[13px] text-ink-secondary">{t("people.empty")}</p>;
  const columns = "grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-4";
  return (
    <div className="flex flex-col">
      <div className={cn(columns, "border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary")}>
        <span>{t("people.colPerson")}</span>
        <span>{t("people.colRole")}</span>
        <span className="text-right">{t("people.colLastSeen")}</span>
        <span className="text-right">{t("people.colMonth")}</span>
        <span />
      </div>
      {people.map((person) => (
        <div key={person.entry} className={cn(columns, "border-b border-hairline/20 py-2 text-[13px]")}>
          <span className="min-w-0">
            <span className="block truncate text-ink">{person.isDomain ? t("people.everyoneAt", { domain: person.entry.slice(1) }) : person.entry}</span>
            {person.devices > 0 && <span className="block text-[11.5px] text-ink-secondary">{t("people.devices", { count: String(person.devices) })}</span>}
          </span>
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", person.role === "admin" ? "bg-accent/15 text-accent" : "bg-control text-ink-secondary")}>
            {person.role === "admin" ? t("people.roleAdmin") : t("people.roleMember")}
          </span>
          <span className="text-right tabular-nums text-ink-secondary">{person.isDomain ? "—" : lastSeenLabel(person.lastSeenAt)}</span>
          <span className="text-right tabular-nums text-ink" title={t("people.turns", { turns: String(person.turns) })}>
            {hasFiniteCost(person.costUsd) ? formatUsd(person.costUsd) : "—"}
          </span>
          <span className="flex items-center justify-end gap-2 text-[12px]">
            <button type="button" disabled={busy} onClick={() => onLink(person)} aria-label={t("people.link")} title={t("people.link")} className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"><Link2 size={13} /></button>
            <button type="button" disabled={busy} onClick={() => onRole(person, person.role === "admin" ? "member" : "admin")} className="text-ink-secondary hover:text-ink disabled:opacity-50">
              {person.role === "admin" ? t("people.makeMember") : t("people.makeAdmin")}
            </button>
            <button type="button" disabled={busy} onClick={() => onRemove(person)} className="text-danger hover:underline disabled:opacity-50">{t("people.remove")}</button>
          </span>
        </div>
      ))}
    </div>
  );
}

export function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      /* the link stays selectable when clipboard access is blocked */
    }
  };
  return (
    <div className="mt-3 rounded-lg border border-hairline/40 bg-inset p-3 text-[12.5px]">
      <div className="mb-1 text-ink-secondary">{t("people.link")}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all text-ink">{link}</code>
        <button type="button" onClick={() => void copy()} className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}{copied ? t("people.copied") : t("people.copy")}
        </button>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">{t("people.linkHint")}</p>
    </div>
  );
}

export function PeopleSection() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [lists, setLists] = useState<SignInLists | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [base, setBase] = useState<string>(typeof window !== "undefined" ? window.location.origin : "");
  const [emailOffered, setEmailOffered] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [config, sessions, usage, domain, environment] = await Promise.all([
        api("/api/config"),
        api("/api/auth/sessions").catch(() => ({ sessions: [] })),
        api("/api/usage?groupBy=user").catch(() => ({ groups: [] })),
        api("/api/settings/custom-domain").catch(() => null),
        fetch("/.well-known/openmausbot/environment").then((res) => (res.ok ? res.json() : null)).catch(() => null),
      ]);
      const current: SignInLists = {
        admins: Array.isArray(config?.signIn?.admins) ? config.signIn.admins : [],
        members: Array.isArray(config?.signIn?.members) ? config.signIn.members : [],
      };
      setLists(current);
      setPeople(mergePeople(current, Array.isArray(sessions?.sessions) ? sessions.sessions : [], Array.isArray(usage?.groups) ? usage.groups : []));
      if (typeof domain?.publicUrl === "string" && domain.publicUrl) setBase(domain.publicUrl);
      setEmailOffered(environment?.capabilities?.emailSignIn === true ? true : environment ? false : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void readSessionState().then((state) => {
      setSession(state);
      if (canPairDevices(state)) void load();
    });
  }, [load]);

  const save = async (next: SignInLists) => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/config", { method: "PUT", body: JSON.stringify({ signIn: next }) });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const invite = async () => {
    if (!lists || busy) return;
    const entry = normalizeAccessEntry(draft);
    if (!entry) {
      setError(t("remote.signInAccess.invalid"));
      return;
    }
    await save(withEntry(lists, entry, role));
    setDraft("");
    setLink(inviteLink(base, entry));
  };

  if (!canPairDevices(session)) return null;
  return (
    <Card title={t("people.title")} subtitle={t("people.subtitle")}>
      {emailOffered === false && <p className="mb-3 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-[12.5px] text-ink-secondary">{t("people.notHosted")}</p>}
      <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void invite(); }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("remote.signInAccess.placeholder")}
          aria-label={t("people.inviteEmail")}
          disabled={busy}
          className="min-w-[16rem] flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50"
        />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label={t("people.colRole")} disabled={busy} className="rounded-lg border border-hairline/40 bg-inset px-2 py-2 text-[12.5px] text-ink focus:border-hairline focus:outline-none">
          <option value="member">{t("people.roleMember")}</option>
          <option value="admin">{t("people.roleAdmin")}</option>
        </select>
        <button type="submit" disabled={busy || !draft.trim()} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-60">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}{t("people.invite")}
        </button>
        <button type="button" onClick={() => void load()} disabled={loading || busy} aria-label={t("people.refresh")} title={t("people.refresh")} className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"><RefreshCw size={13} className={cn(loading && "animate-spin")} /></button>
      </form>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">{t("people.inviteHint")}</p>
      {link && <CopyLink link={link} />}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      <div className="mt-4">
        <PeopleTable
          people={people}
          busy={busy}
          onRole={(person, next) => { if (lists) void save(withEntry(lists, person.entry, next)); }}
          onRemove={(person) => { if (lists) void save(withoutEntry(lists, person.entry)); }}
          onLink={(person) => setLink(inviteLink(base, person.entry))}
        />
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-secondary">{t("people.note")}</p>
    </Card>
  );
}
