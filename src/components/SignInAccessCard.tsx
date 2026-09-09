import { useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import { readSessionState, type SessionState } from "../lib/session";
import { canPairDevices } from "./ServerPairingCard";
import { Card } from "./SettingsPrimitives";

export interface SignInLists {
  admins: string[];
  members: string[];
}

/** An address or `@domain`, lower-cased; null when it is neither. */
export function normalizeAccessEntry(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value || /\s/.test(value)) return null;
  if (value.startsWith("@")) return /^@[^@\s]+\.[^@\s]+$/.test(value) ? value : null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? value : null;
}

/** Adding moves an entry between the lists rather than duplicating it. */
export function withEntry(lists: SignInLists, entry: string, role: "admin" | "member"): SignInLists {
  const admins = lists.admins.filter((item) => item !== entry);
  const members = lists.members.filter((item) => item !== entry);
  return role === "admin" ? { admins: [...admins, entry], members } : { admins, members: [...members, entry] };
}

export function withoutEntry(lists: SignInLists, entry: string): SignInLists {
  return { admins: lists.admins.filter((item) => item !== entry), members: lists.members.filter((item) => item !== entry) };
}

const input = "w-full rounded-md border border-line bg-surface px-3 py-2 text-[14px] text-ink outline-none focus:border-accent-border";
const button = "rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink disabled:opacity-50";
const quiet = "rounded-md border border-line px-2.5 py-1 text-[12px] text-ink hover:bg-surface";

/** Settings → Remote access on a hosted server: who may sign in at /pair
 * with an emailed code. Admins only; saved through the config API and
 * applied on the next request, so no restart. */
export function SignInAccessCard() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [lists, setLists] = useState<SignInLists | null>(null);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<"admin" | "member">("admin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);

  async function load() {
    try {
      const config = await api("/api/config");
      const current = config?.signIn;
      setLists({ admins: Array.isArray(current?.admins) ? current.admins : [], members: Array.isArray(current?.members) ? current.members : [] });
      const domain = await api("/api/settings/custom-domain").catch(() => null);
      setPublicUrl(typeof domain?.publicUrl === "string" ? domain.publicUrl : null);
    } catch (e) {
      setError(t("remote.signInAccess.error", { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  useEffect(() => {
    void readSessionState().then((state) => {
      setSession(state);
      if (canPairDevices(state)) void load();
    });
  }, []);

  if (!canPairDevices(session) || !lists) return null;

  async function save(next: SignInLists) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/config", { method: "PUT", body: JSON.stringify({ signIn: next }) });
      setLists(next);
    } catch (e) {
      setError(t("remote.signInAccess.error", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const entry = normalizeAccessEntry(draft);
    if (!entry || !lists) {
      setError(t("remote.signInAccess.invalid"));
      return;
    }
    await save(withEntry(lists, entry, role));
    setDraft("");
  }

  const rows = [...lists.admins.map((entry) => ({ entry, role: "admin" as const })), ...lists.members.map((entry) => ({ entry, role: "member" as const }))];

  return (
    <Card title={t("remote.signInAccess.title")} subtitle={t("remote.signInAccess.subtitle")}>
      {publicUrl ? (
        <p className="mt-2 text-[12.5px] text-ink-secondary">
          {t("remote.signInAccess.link")} <code className="select-all text-ink">{publicUrl}/pair</code>
        </p>
      ) : null}
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("remote.signInAccess.placeholder")}
          autoComplete="off"
          spellCheck={false}
          className={`${input} max-w-[320px] flex-1`}
          aria-label={t("remote.signInAccess.placeholder")}
        />
        <label className="flex items-center gap-1.5 text-[13px] text-ink">
          <input type="radio" name="signin-role" checked={role === "admin"} onChange={() => setRole("admin")} />
          {t("remote.serverPairing.scope.admin")}
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-ink">
          <input type="radio" name="signin-role" checked={role === "member"} onChange={() => setRole("member")} />
          {t("remote.serverPairing.scope.client")}
        </label>
        <button type="submit" disabled={busy || !draft.trim()} className={button}>
          {t("remote.signInAccess.add")}
        </button>
      </form>
      {rows.length === 0 ? (
        <p className="mt-3 text-[12.5px] text-ink-secondary">{t("remote.signInAccess.empty")}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {rows.map(({ entry, role: entryRole }) => (
            <li key={entry} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
              <span className="text-ink">
                {entry}
                <span className="text-ink-secondary"> · {entryRole === "admin" ? t("remote.serverPairing.scope.admin") : t("remote.serverPairing.scope.client")}</span>
              </span>
              <button type="button" disabled={busy} onClick={() => void save(withoutEntry(lists, entry))} className={quiet}>
                {t("remote.signInAccess.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-secondary">{t("remote.signInAccess.note")}</p>
      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
    </Card>
  );
}
