// The Boat / Self-hosted VPS segmented control shown under the "Runs on"
// picker whenever a bot can end up on a cloud computer. One component, two
// homes (ComputerPanel and the bot settings dialog's Access section), so the copy and the disabled
// rules can never drift apart.
import type { CloudBackend } from "../../shared/wire";
import { cn } from "@/lib/cn";
import { OrgoLogo } from "./OrgoLogo";

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
  return (
    <div className="mt-3 rounded-lg bg-inset p-3">
      <div className="text-[12px] font-medium text-ink">{compact ? "Cloud provider" : "Cloud backend"}</div>
      <div className="mt-0.5 text-[11.5px] text-ink-secondary">
        {compact
          ? value === "vps" ? "Your own server, connected over SSH." : value === "orgo" ? "A cloud computer in your Orgo workspace." : "A hosted computer managed by Boat."
          : value === "vps"
          ? "Auto reuses a running VPS by default. Enable Start VPS automatically to let Auto create or wake its managed container, or choose Cloud to do it explicitly. Open the live desktop securely from the computer panel."
          : value === "orgo"
          ? "Connect your own Orgo key and workspace in Settings → Connections. Choose Cloud to create or start this bot's computer; Auto only reuses an existing one."
          : "Boat is the default hosted computer. Choose Self-hosted VPS to use your SSH-configured Linux Docker host."}
      </div>
      <div className="mt-2 flex overflow-hidden rounded-lg border border-hairline/40">
        {(["box", "orgo", "vps"] as const).map((backend, i) => {
          const disabled = backend !== "box" && !vpsSupported;
          return (
            <button
              key={backend}
              aria-pressed={value === backend}
              data-cloud-provider={backend}
              disabled={disabled}
              title={disabled ? `${backend === "orgo" ? "Orgo" : "Self-hosted VPS"} requires a model provider with computer tools` : undefined}
              onClick={() => { if (backend !== value) onChange(backend); }}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 py-1.5 text-[12px]",
                i > 0 && "border-l border-hairline/40",
                disabled && "cursor-not-allowed opacity-40",
                value === backend ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
              )}
            >
              {backend === "orgo" && <OrgoLogo className="size-3.5" />}
              {backend === "vps" ? "Self-hosted VPS" : backend === "orgo" ? "Orgo" : "Boat"}
            </button>
          );
        })}
      </div>
    </div>
  );
}
