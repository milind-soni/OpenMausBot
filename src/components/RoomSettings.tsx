import { useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { useStore, type Bot, type Group, type RoomHandoffs } from "@/state/store";
import { normalizeState } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { MausAvatar } from "./Avatar";

const HANDOFF_OPTIONS: { value: RoomHandoffs; label: string }[] = [
  { value: "inherit", label: "App default" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];
const IDLE_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "App default (20 min)" },
  { value: 10, label: "10 min" },
  { value: 20, label: "20 min" },
  { value: 45, label: "45 min" },
  { value: 90, label: "90 min" },
];
// a safety cap on bots looping, not a depth: mentions are answered below it
const HOP_OPTIONS = [5, 10, 25];
const DEFAULT_HOPS = 10;

type RoomPatch = Partial<Pick<Group, "name" | "bulletin" | "memberIds" | "handoffs" | "defaultResponderId" | "maxHops" | "turnIdleMinutes" | "projectId">>;

const fieldClass =
  "w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none";

/** One place to manage a room: name, bulletin, project, members and how
 * its bots behave. Toggles save immediately; text fields save on blur. */
export function RoomSettings({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const group = state.groups.find((g) => g.id === groupId);
  const [name, setName] = useState(group?.name ?? "");
  const [bulletin, setBulletin] = useState(group?.bulletin ?? "");
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Bot | null>(null);

  useEffect(() => setName(group?.name ?? ""), [group?.name]);
  useEffect(() => setBulletin(group?.bulletin ?? ""), [group?.bulletin]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      if (confirmRemove) setConfirmRemove(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmRemove, onClose]);

  const members = useMemo(
    () => (group?.memberIds ?? []).map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)),
    [group?.memberIds, state.bots],
  );
  const candidates = useMemo(
    () => state.bots.filter((b) => !b.hidden && !group?.memberIds.includes(b.id)),
    [state.bots, group?.memberIds],
  );
  if (!group) return null;

  const patch = (next: RoomPatch) => dispatch({ type: "patchGroup", groupId: group.id, patch: next });
  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) return setName(group.name);
    if (trimmed !== group.name) patch({ name: trimmed });
  };
  const commitBulletin = () => {
    if (bulletin !== group.bulletin) patch({ bulletin });
  };
  const isWorking = (id: string) => group.busyBotId === id || Boolean(group.queuedBotIds?.includes(id));
  const removeMember = (bot: Bot) => {
    const memberIds = group.memberIds.filter((id) => id !== bot.id);
    patch({
      memberIds,
      ...(group.defaultResponderId === bot.id ? { defaultResponderId: null } : {}),
    });
    setConfirmRemove(null);
  };
  const requestRemove = (bot: Bot) => (isWorking(bot.id) ? setConfirmRemove(bot) : removeMember(bot));
  const addMember = (bot: Bot) => {
    patch({ memberIds: [...group.memberIds, bot.id] });
    if (candidates.length <= 1) setAdding(false);
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${group.name} settings`}
        className="flex max-h-[85vh] w-[460px] max-w-full flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-hairline/40 px-4 py-3">
          <div className="text-[15px] font-semibold text-ink">Room settings</div>
          <button type="button" aria-label="Close room settings" onClick={onClose} className="rounded-lg p-1 text-ink-secondary hover:bg-raised">
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto px-4 py-4">
          <Section title="General">
            <Field label="Name">
              <input
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
                className={fieldClass}
              />
            </Field>
            <Field label="Bulletin" hint="Shared instructions every Buddy in this room reads.">
              <textarea
                value={bulletin}
                rows={3}
                onChange={(e) => setBulletin(e.target.value)}
                onBlur={commitBulletin}
                placeholder="e.g. Work on the #project repo. Commit after each step."
                className={cn(fieldClass, "resize-y")}
              />
            </Field>
            <Field label="Project">
              <select
                value={group.projectId ?? ""}
                onChange={(e) => patch({ projectId: e.target.value || null })}
                className={fieldClass}
              >
                <option value="">No project</option>
                {state.taskProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    #{project.mention} · {project.name}
                    {project.available ? "" : " (unavailable)"}
                  </option>
                ))}
              </select>
            </Field>
          </Section>

          <Section title={`Members · ${members.length}`}>
            <ul className="flex flex-col gap-0.5">
              {members.map((bot) => (
                <li key={bot.id} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-raised/40">
                  <MausAvatar color={bot.color} state={normalizeState(bot.mascotExpression) ?? "happy"} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-ink">{bot.name}</div>
                    {bot.title && <div className="truncate text-[11px] text-ink-secondary">{bot.title}</div>}
                  </div>
                  {group.busyBotId === bot.id && <Badge>Working</Badge>}
                  {group.queuedBotIds?.includes(bot.id) && <Badge>Queued</Badge>}
                  <button
                    type="button"
                    disabled={members.length <= 1}
                    title={members.length <= 1 ? "A room needs at least one Buddy" : `Remove ${bot.name}`}
                    aria-label={`Remove ${bot.name}`}
                    onClick={() => requestRemove(bot)}
                    className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-danger disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-secondary"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            {adding ? (
              <div className="mt-1 rounded-lg border border-hairline/40 p-1">
                {candidates.map((bot) => (
                  <button
                    key={bot.id}
                    type="button"
                    onClick={() => addMember(bot)}
                    className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-raised/50"
                  >
                    <MausAvatar color={bot.color} state="happy" size={24} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{bot.name}</span>
                    <Plus size={14} className="text-ink-secondary" />
                  </button>
                ))}
                <button type="button" onClick={() => setAdding(false)} className="w-full rounded-md px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-raised/50">
                  Done
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={!candidates.length}
                title={candidates.length ? undefined : "Every Buddy is already in this room"}
                onClick={() => setAdding(true)}
                className="mt-1 flex items-center gap-1.5 self-start rounded-lg px-2 py-1.5 text-[13px] text-accent hover:bg-raised/60 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Plus size={14} /> Add Buddies
              </button>
            )}
          </Section>

          <Section title="Behaviour">
            <Field group label="Auto handoffs" hint="When a Buddy @mentions a teammate, the teammate picks up the work.">
              <Segmented
                label="Auto handoffs"
                options={HANDOFF_OPTIONS}
                value={group.handoffs}
                onChange={(handoffs) => patch({ handoffs })}
              />
            </Field>
            <Field group label="Handoffs in a row" hint="A mentioned Buddy always answers. After this many Buddy-to-Buddy handoffs without you, the room pauses until you step in.">
              <Segmented
                label="Handoffs in a row"
                options={HOP_OPTIONS.map((n) => ({ value: n, label: String(n) }))}
                value={group.maxHops ?? DEFAULT_HOPS}
                onChange={(maxHops) => patch({ maxHops })}
              />
            </Field>
            <Field label="Answers unmentioned messages" hint="Who replies when you don't @mention anyone.">
              <select
                value={group.defaultResponderId ?? ""}
                onChange={(e) => patch({ defaultResponderId: e.target.value || null })}
                className={fieldClass}
              >
                <option value="">{members.length === 1 ? `${members[0].name} (only member)` : "Nobody — @mention a Buddy"}</option>
                {members.length > 1 && members.map((bot) => (
                  <option key={bot.id} value={bot.id}>{bot.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Stop a Buddy after it goes quiet for" hint="Active Buddies keep working; this only stops a stuck turn. Hard limit: 3 h.">
              <select
                value={group.turnIdleMinutes ?? ""}
                onChange={(e) => patch({ turnIdleMinutes: e.target.value ? Number(e.target.value) : null })}
                className={fieldClass}
              >
                {IDLE_OPTIONS.map((option) => (
                  <option key={option.label} value={option.value ?? ""}>{option.label}</option>
                ))}
              </select>
            </Field>
          </Section>
        </div>
      </div>

      {confirmRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && setConfirmRemove(null)}>
          <div role="alertdialog" aria-label={`Remove ${confirmRemove.name}?`} className="w-[340px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl">
            <div className="text-[15px] font-semibold text-ink">Remove {confirmRemove.name}?</div>
            <p className="mt-1.5 text-[13px] leading-5 text-ink-secondary">
              {confirmRemove.name} is {group.busyBotId === confirmRemove.id ? "working right now" : "queued to reply"}. Removing it stops that work; anything it hasn't saved yet may be lost.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmRemove(null)} className="rounded-lg px-3 py-1.5 text-[13px] text-ink hover:bg-raised">
                Cancel
              </button>
              <button type="button" autoFocus onClick={() => removeMember(confirmRemove)} className="rounded-lg bg-danger px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110">
                Stop and remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">{title}</h3>
      {children}
    </section>
  );
}

/** A labelled control. `group` renders a div, for controls made of several
 * buttons — a <label> would forward clicks on its text to the first one. */
function Field({ label, hint, group, children }: { label: string; hint?: string; group?: boolean; children: React.ReactNode }) {
  const Wrapper = group ? "div" : "label";
  return (
    <Wrapper className="flex flex-col gap-1.5">
      <span className="text-[13px] text-ink">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-4 text-ink-secondary">{hint}</span>}
    </Wrapper>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">{children}</span>;
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-hairline/50 bg-inset p-0.5">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => option.value !== value && onChange(option.value)}
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-[12px] transition-colors",
            option.value === value ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
