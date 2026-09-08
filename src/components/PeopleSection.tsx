// The People admin panel (phase 6 of docs/plans/2026-09-07-users-and-roles.md).
// A settings section over the /api/auth/users API: who exists, add someone,
// pair their device, change their role, switch them off, and see the devices
// signed in. Admin-only on the server; a member who opens it sees the error
// the server returns and nothing else.
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Eye, EyeOff, ShieldCheck, User as UserIcon, UserMinus, UserPlus } from "lucide-react";
import { api, useStore } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";

interface Person {
  id: string;
  name: string;
  email: string | null;
  role: "admin" | "member";
  status: "active" | "disabled";
}
interface Device {
  id: string;
  label: string;
  userId: string | null;
  user: { id: string; name: string } | null;
  scopes: string[];
  lastSeenAt: number;
}

/** Who may see each bot. Admins always see every bot, so the choice is only
 * ever about members: everyone, nobody but admins, or a named few. */
function BotAccessCard({ people, onError }: { people: Person[]; onError: (message: string) => void }) {
  const { state } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const bots = state.bots.filter((bot) => !bot.hidden);
  const members = people.filter((p) => p.role === "member");

  const set = async (botId: string, body: { mode: "everyone" } | { mode: "restricted"; userIds: string[] }) => {
    setBusy(botId);
    try {
      await api(`/api/bots/${botId}/visibility`, { method: "PATCH", body: JSON.stringify(body) });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not change who can see that bot.");
    } finally {
      setBusy(null);
    }
  };

  const describe = (bot: { visibility?: { mode: string; userIds?: string[] } }) => {
    if (!bot.visibility || bot.visibility.mode === "everyone") return "everyone";
    const ids = bot.visibility.userIds ?? [];
    if (!ids.length) return "admins only";
    const names = ids.map((id) => people.find((p) => p.id === id)?.name ?? "someone");
    return `admins + ${names.join(", ")}`;
  };

  return (
    <Card
      title="Who can see which bot"
      subtitle="Admins always see every bot. This limits what members see — a bot they cannot see is absent from their list entirely."
    >
      {bots.length === 0 ? (
        <div className="text-[13px] text-ink-secondary">No bots yet.</div>
      ) : (
        <div className="flex flex-col divide-y divide-hairline/30">
          {bots.map((bot) => {
            const visibility = bot.visibility;
            const restricted = visibility?.mode === "restricted";
            const chosen: string[] = visibility?.mode === "restricted" ? visibility.userIds : [];
            const open = expanded === bot.id;
            return (
              <div key={bot.id} className="py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {restricted ? <EyeOff size={14} className="shrink-0 text-gap" /> : <Eye size={14} className="shrink-0 text-ink-secondary" />}
                    <span className="truncate text-[14px] font-medium text-ink">{bot.name}</span>
                    <span className="truncate text-[12px] text-ink-secondary">{describe(bot)}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <select
                      value={restricted ? "restricted" : "everyone"}
                      disabled={busy !== null}
                      onChange={(e) => {
                        if (e.target.value === "everyone") {
                          setExpanded(null);
                          void set(bot.id, { mode: "everyone" });
                        } else {
                          setExpanded(bot.id);
                          void set(bot.id, { mode: "restricted", userIds: [] });
                        }
                      }}
                      className="rounded-md bg-inset px-1.5 py-1 text-[12px] text-ink outline-none disabled:opacity-40"
                      aria-label={`Who can see ${bot.name}`}
                    >
                      <option value="everyone">Everyone</option>
                      <option value="restricted">Restricted</option>
                    </select>
                    {restricted && members.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : bot.id)}
                        className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink"
                      >
                        {open ? "Done" : "Choose people"}
                      </button>
                    )}
                  </div>
                </div>
                {restricted && open && (
                  <div className="mt-2 flex flex-wrap gap-2 pl-6">
                    {members.length === 0 ? (
                      <span className="text-[12px] text-ink-secondary">No members yet — only admins can see this bot.</span>
                    ) : (
                      members.map((person) => {
                        const on = chosen.includes(person.id);
                        return (
                          <label key={person.id} className="flex items-center gap-1.5 rounded-md bg-inset px-2 py-1 text-[12px] text-ink">
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={busy !== null}
                              onChange={() =>
                                void set(bot.id, {
                                  mode: "restricted",
                                  userIds: on ? chosen.filter((id: string) => id !== person.id) : [...chosen, person.id],
                                })
                              }
                            />
                            {person.name}
                          </label>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function relativeTime(ms: number): string {
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

export function PeopleSection() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  // add-person form
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");

  // the pairing code just minted, shown until dismissed
  const [pairing, setPairing] = useState<{ personName: string; code: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [u, s] = await Promise.all([api("/api/auth/users"), api("/api/auth/sessions")]);
      setPeople(u.users);
      setDevices(s.sessions);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load people.");
      setPeople([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };

  const addPerson = async () => {
    if (!name.trim()) return;
    await run("add", async () => {
      const body: Record<string, unknown> = { name: name.trim(), role };
      if (email.trim()) body.email = email.trim();
      await api("/api/auth/users", { method: "POST", body: JSON.stringify(body) });
      setName("");
      setEmail("");
      setRole("member");
    });
  };

  const pair = async (person: Person) =>
    run(`pair:${person.id}`, async () => {
      const { code } = await api("/api/auth/pairing", { method: "POST", body: JSON.stringify({ userId: person.id }) });
      setPairing({ personName: person.name, code });
      setCopied(false);
    });

  const deviceCount = (id: string) => devices.filter((d) => d.userId === id).length;

  return (
    <>
      <Card title="People" subtitle="Who can reach this server, and what they may do. A member can chat and read every conversation; an admin can also change settings and manage people.">
        {error && <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>}

        {people === null ? (
          <div className="text-[13px] text-ink-secondary">Loading…</div>
        ) : people.length === 0 ? (
          <div className="text-[13px] text-ink-secondary">No accounts yet. Add the first person below — until you do, every paired device has full access.</div>
        ) : (
          <div className="flex flex-col divide-y divide-hairline/30">
            {people.map((person) => (
              <div key={person.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", person.role === "admin" ? "bg-accent/15 text-accent" : "bg-control text-ink-secondary")}>
                    {person.role === "admin" ? <ShieldCheck size={15} /> : <UserIcon size={15} />}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={cn("truncate text-[14px] font-medium", person.status === "disabled" ? "text-ink-secondary line-through" : "text-ink")}>{person.name}</span>
                      <span className="shrink-0 rounded-full bg-control px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-secondary">{person.role}</span>
                      {person.status === "disabled" && <span className="shrink-0 text-[11px] text-danger">disabled</span>}
                    </div>
                    <div className="truncate text-[12px] text-ink-secondary">
                      {person.email ?? "no email"} · {deviceCount(person.id)} device{deviceCount(person.id) === 1 ? "" : "s"}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void pair(person)}
                    disabled={busy !== null || person.status === "disabled"}
                    className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
                    title="Create a pairing code for a new device"
                  >
                    Pair device
                  </button>
                  <select
                    value={person.role}
                    disabled={busy !== null}
                    onChange={(e) => void run(`role:${person.id}`, () => api(`/api/auth/users/${person.id}`, { method: "PATCH", body: JSON.stringify({ role: e.target.value }) }))}
                    className="rounded-md bg-inset px-1.5 py-1 text-[12px] text-ink outline-none disabled:opacity-40"
                    aria-label={`Role for ${person.name}`}
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => void run(`toggle:${person.id}`, () => api(`/api/auth/users/${person.id}`, { method: "PATCH", body: JSON.stringify({ status: person.status === "active" ? "disabled" : "active" }) }))}
                    disabled={busy !== null}
                    className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
                  >
                    {person.status === "active" ? "Disable" : "Enable"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* add a person */}
        <form
          className="mt-4 flex flex-wrap items-end gap-2 border-t border-hairline/30 pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void addPerson();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-ink-secondary">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Ada Lovelace" className="w-40 rounded-md bg-inset px-2 py-1.5 text-[13px] text-ink outline-none" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-ink-secondary">Email (optional)</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="ada@example.com" className="w-48 rounded-md bg-inset px-2 py-1.5 text-[13px] text-ink outline-none" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-ink-secondary">Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value as "admin" | "member")} className="rounded-md bg-inset px-2 py-1.5 text-[13px] text-ink outline-none">
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <button type="submit" disabled={busy === "add" || !name.trim()} className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink disabled:opacity-50">
            <UserPlus size={14} /> Add person
          </button>
        </form>
      </Card>

      {/* the pairing code, once minted */}
      {pairing && (
        <Card title={`Pair a device for ${pairing.personName}`} subtitle="Open /pair on the device and type this code. It is single-use and expires in five minutes.">
          <div className="flex items-center gap-3">
            <code className="rounded-lg bg-inset px-3 py-2 font-mono text-[18px] tracking-widest text-ink">{pairing.code}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(pairing.code);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
              className="flex items-center gap-1.5 rounded-md bg-control px-2.5 py-2 text-[13px] text-ink-secondary hover:text-ink"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" onClick={() => setPairing(null)} className="ml-auto text-[13px] text-ink-secondary hover:text-ink">
              Done
            </button>
          </div>
        </Card>
      )}

      {/* who can see which bot */}
      <BotAccessCard people={(people ?? []).filter((p) => p.status === "active")} onError={setError} />

      {/* signed-in devices */}
      <Card title="Devices" subtitle="Every device paired to this server. Revoking one signs it out at once.">
        {devices.length === 0 ? (
          <div className="text-[13px] text-ink-secondary">No devices paired.</div>
        ) : (
          <div className="flex flex-col divide-y divide-hairline/30">
            {devices.map((device) => (
              <div key={device.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[14px] text-ink">{device.label || "(unnamed device)"}</div>
                  <div className="truncate text-[12px] text-ink-secondary">
                    {device.user ? device.user.name : "no account"} · {device.scopes.includes("admin") ? "admin" : "chat only"} · seen {relativeTime(device.lastSeenAt)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void run(`revoke:${device.id}`, () => api(`/api/auth/sessions/${device.id}`, { method: "DELETE" }))}
                  disabled={busy !== null}
                  className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-40"
                >
                  <UserMinus size={13} /> Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
