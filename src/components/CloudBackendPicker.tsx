import { isAddedProvider } from "../../shared/hosted-computers";
import { useStore } from "@/state/store";
import { isProductAdmin } from "@/lib/admin-gate";
// The Box / Self-hosted VPS segmented control shown under the "Runs on"
// picker whenever a bot can end up on a cloud computer. One component, two
// homes (ComputerPanel and the bot settings dialog's Access section), so the copy and the disabled
// rules can never drift apart.
import type { CloudBackend } from "../../shared/wire";
import { cn } from "@/lib/cn";

export function CloudBackendPicker({
  value,
  compact = false,
  vpsSupported,
  onChange,
}: {
  value: CloudBackend;
  compact?: boolean;
  vpsSupported: boolean;
  onChange: (backend: CloudBackend) => void;
}) {
  const { state } = useStore();
  if (!isProductAdmin({ isProductOwner: state.config?.isProductOwner, pinRequired: state.config?.adminGate?.pinRequired })) return <p className="mt-3 text-sm text-ink-secondary">NATION Isolated PC</p>;
  return (
    <div className="mt-3 rounded-lg bg-inset p-3">
      <div className="text-[12px] font-medium text-ink">{compact ? "Cloud provider" : "Cloud backend"}</div>
      <div className="mt-0.5 text-[11.5px] text-ink-secondary">
        {compact
          ? value === "vps" ? "Your own server, connected over SSH." : "A remote computer managed by NATION."
          : value === "vps"
          ? "Auto reuses a running VPS by default. Enable Start VPS automatically to let Auto create or wake its managed container, or choose Cloud to do it explicitly. Open the live desktop securely from the computer panel."
          : "Choose an enabled cloud provider. Changing providers does not move existing files; the previous computer is kept."}
      </div>
      <div className="mt-2 flex overflow-hidden rounded-lg border border-hairline/40">
        {(["box", "vps", "orgo", "daytona"] as const).map((backend, i) => {
          const configured = isAddedProvider(backend) ? state.config?.hostedComputers?.[backend].enabled && state.config.hostedComputers[backend].configured : backend === "vps" ? state.config?.vps?.configured : state.config?.box?.configured;
          const disabled = !configured || (backend === "vps" && !vpsSupported);
          return (
            <button
              key={backend}
              disabled={disabled}
              aria-pressed={value === backend}
              title={!configured ? "Configure this backend at /admin" : disabled ? "This engine does not support a self-hosted VPS" : undefined}
              onClick={() => onChange(backend)}
              className={cn(
                "flex-1 py-1.5 text-[12px]",
                i > 0 && "border-l border-hairline/40",
                disabled && "cursor-not-allowed opacity-40",
                value === backend ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
              )}
            >
              {backend === "vps" ? "Self-hosted VPS" : backend === "orgo" ? "Orgo" : backend === "daytona" ? "Daytona" : "Box"}
            </button>
          );
        })}
      </div>
    </div>
  );
}
