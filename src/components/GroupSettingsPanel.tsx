import { ChevronLeft, X } from "lucide-react";
import { useStore, type Group } from "@/state/store";
import { cn } from "@/lib/cn";
import { GroupProfileAvatarCard } from "./GroupProfileAvatarCard";

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[13px] text-ink-secondary">{label}</div>
      {children}
    </label>
  );
}

export function GroupSettingsPanel({ group }: { group: Group }) {
  const { dispatch } = useStore();
  const patch = (p: Partial<Pick<Group, "name" | "bulletin" | "avatarUrl" | "avatarCrop">>) =>
    dispatch({ type: "patchGroup", groupId: group.id, patch: p });

  return (
    <aside className="animate-panel-in relative z-20 flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label="Collapse channel settings"
          title="Collapse channel settings"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">Channel settings</span>
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label="Close channel settings"
          title="Close channel settings"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex flex-col gap-4 pt-4">
          <GroupProfileAvatarCard group={group} onPatch={patch} />

          <Field label="Name">
            <input
              className={inputCls}
              maxLength={40}
              value={group.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          
          <Field label="Bulletin (Instructions)">
            <textarea
              className={cn(inputCls, "min-h-[96px] resize-none")}
              maxLength={500}
              placeholder="Goals, tone, ownership, constraints..."
              value={group.bulletin}
              onChange={(e) => patch({ bulletin: e.target.value })}
            />
          </Field>
        </div>
      </div>
    </aside>
  );
}
