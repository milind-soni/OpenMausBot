// A member's own workspace (server/workspace-host.ts): where a bot works and
// what it works on. Only what the workspace's config turns on is offered:
// NATION's cloud computer for this bot and account, and the guarded browser.
// Never this machine, and never another account's computer.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { browserAvailable, builtInBrowserEnabled } from "@/lib/feature-flags";
import { cn } from "@/lib/cn";
import { api, useStore, type Bot } from "@/state/store";
import { LiveBrowser } from "./BrowserPanel";

export type WorkspacePlace = "cloud" | "browser" | "off" | null;

type WorkspaceConfig = {
  personalWorkspace?: boolean;
  isProductOwner?: boolean;
  features?: { computers?: boolean; browser?: boolean };
  browserEngine?: { kind: "engine" | "unavailable" };
} | null | undefined;

/** What this workspace offers its member, from the server's own config. */
export function workspaceToolsOn(config: WorkspaceConfig): { cloud: boolean; browser: boolean } {
  const personal = config?.personalWorkspace === true || config?.isProductOwner === true;
  return {
    cloud: personal && config?.features?.computers === true,
    browser: personal && builtInBrowserEnabled(config) && browserAvailable(config),
  };
}

function placeOf(bot: Bot): WorkspacePlace {
  return bot.computer === "cloud" || bot.computer === "browser" || bot.computer === "off" ? bot.computer : null;
}

type StateKey = "computer.workspace.state.none" | "computer.workspace.state.running" | "computer.workspace.state.sleeping" | "computer.workspace.state.starting";

function stateKey(state: string | null): StateKey {
  if (state === null) return "computer.workspace.state.none";
  if (["idle", "ready", "running"].includes(state)) return "computer.workspace.state.running";
  if (["archived", "archiving", "stopped", "stopping"].includes(state)) return "computer.workspace.state.sleeping";
  return "computer.workspace.state.starting";
}

const choice = "rounded-lg px-3 py-1.5 text-[12.5px] transition-colors disabled:opacity-50";
const action = "rounded-lg bg-inset px-3 py-1.5 text-[12.5px] text-ink hover:bg-control disabled:opacity-50";

export function WorkspaceComputerControls({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const tools = workspaceToolsOn(state.config);
  const [place, setPlace] = useState<WorkspacePlace>(placeOf(bot));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [computerState, setComputerState] = useState<string | null | undefined>(undefined);
  const [screen, setScreen] = useState<string | null>(null);
  useEffect(() => { setPlace(placeOf(bot)); }, [bot]);

  const refresh = async () => {
    const status = await api<{ state?: string | null }>(`/api/bots/${bot.id}/computer`);
    setComputerState(status.state ?? null);
  };
  useEffect(() => {
    if (place === "cloud" && tools.cloud) void refresh().catch(() => setComputerState(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, place, tools.cloud]);

  const run = async (work: () => Promise<void>) => {
    setPending(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  const choose = (next: WorkspacePlace) => run(async () => {
    const body = next === "cloud" ? { computer: "cloud" } : next === "browser" ? { computer: "browser", browser: true } : { computer: next };
    await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify(body) });
    setPlace(next);
  });
  const act = (step: "provision" | "sleep" | "screenshot") => run(async () => {
    const result = await api<{ png?: string; format?: string }>(`/api/bots/${bot.id}/computer/${step}`, { method: "POST", body: "{}" });
    if (step === "screenshot") setScreen(result.png ? `data:image/${result.format === "png" ? "png" : "jpeg"};base64,${result.png}` : null);
    else await refresh();
  });

  const options: Array<{ value: WorkspacePlace; label: string }> = [
    { value: null, label: t("computer.workspace.auto") },
    ...(tools.cloud ? [{ value: "cloud" as const, label: t("computer.workspace.cloud") }] : []),
    ...(tools.browser ? [{ value: "browser" as const, label: t("computer.workspace.browser") }] : []),
    { value: "off", label: t("computer.workspace.off") },
  ];
  const running = computerState !== undefined && computerState !== null && ["idle", "ready", "running"].includes(computerState);

  return (
    <div className="flex flex-col gap-3" data-testid="workspace-computer">
      <div className="rounded-xl bg-card p-4">
        <div className="text-[13px] font-medium text-ink">{t("computer.workspace.worksOn")}</div>
        <div role="radiogroup" aria-label={t("computer.workspace.worksOn")} className="mt-2 flex flex-wrap gap-1.5">
          {options.map((option) => (
            <button
              key={option.value ?? "auto"}
              type="button"
              role="radio"
              aria-checked={place === option.value}
              disabled={pending}
              onClick={() => { if (place !== option.value) void choose(option.value); }}
              className={cn(choice, place === option.value ? "bg-accent text-accent-ink" : "bg-inset text-ink hover:bg-control")}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {place === "cloud" && tools.cloud ? (
        <div className="rounded-xl bg-card p-4" data-testid="workspace-cloud-computer">
          <p className="text-[12.5px] leading-5 text-ink-secondary">{t("computer.workspace.cloudBody", { name: bot.name })}</p>
          <div className="mt-2 text-[12.5px] text-ink">
            {computerState === undefined ? <Loader2 size={14} className="animate-spin" /> : t(stateKey(computerState))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {running
              ? <button type="button" className={action} disabled={pending} onClick={() => void act("sleep")}>{t("computer.workspace.sleep")}</button>
              : <button type="button" className={action} disabled={pending} onClick={() => void act("provision")}>{t("computer.workspace.start")}</button>}
            <button type="button" className={action} disabled={pending || !running} onClick={() => void act("screenshot")}>{t("computer.workspace.look")}</button>
          </div>
          {screen ? <img src={screen} alt={t("computer.workspace.screenAlt", { name: bot.name })} className="mt-3 w-full rounded-lg" /> : null}
        </div>
      ) : null}
      {place === "browser" && tools.browser ? (
        <div className="overflow-hidden rounded-xl bg-card" data-testid="workspace-browser">
          <p className="px-4 pt-3 text-[12.5px] leading-5 text-ink-secondary">{t("computer.workspace.browserBody", { name: bot.name })}</p>
          <LiveBrowser bot={bot} profiles={false} />
        </div>
      ) : null}
      {error ? <p role="alert" className="text-[12.5px] text-danger">{error}</p> : null}
    </div>
  );
}
