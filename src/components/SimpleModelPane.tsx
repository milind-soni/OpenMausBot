// The model picker as Simple mode shows it: every provider the picker knows in
// a narrow column on the left (one on an API key carries a small key on its
// mark, one an organisation blocks is dimmed), that provider's models by name
// on the right, and along the bottom how hard the bot thinks and whether new
// chats follow. A sign-in with several accounts switches account above its
// models. A long model list opens in place with "Show all" (and a search box
// when it is very long), so no model needs the full picker; only setup goes
// there.
import type { ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, KeyRound, Loader2 } from "lucide-react";
import type { InstanceInfo } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import { InstanceProviderMark } from "./ProviderIcons";
import type { RailProvider } from "./ModelPicker";
import { friendlyEffort, modelBlurb } from "@/lib/model-friendly";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

type ModelOption = InstanceInfo["models"]["options"][number];

/** Names more than one of a provider's models carry (pi lists one model under
 * several routes). Those rows add their route so they read apart. */
export function repeatedModelLabels(options: readonly ModelOption[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const option of options) (seen.has(option.label) ? repeated : seen).add(option.label);
  return repeated;
}

/** An API-key row carries the key on its mark, so "(API key)" in its name
 * says it twice and costs the narrow column most of the name. */
function providerName(provider: RailProvider): string {
  if (provider.target.access !== "api") return provider.label;
  return provider.label.replace(/\s*\((?:API key|API)\)$/i, "") || provider.label;
}

export function SimpleModelPane({
  providers,
  onProvider,
  account,
  managedBy,
  needsSetup,
  signIn,
  onSetUp,
  models,
  repeatedLabels,
  query,
  showAll,
  search,
  onRefresh,
  refreshing = false,
  currentModelId,
  onPick,
  effort,
  variantsRow,
  onManage,
}: {
  providers: RailProvider[];
  onProvider: (instance: InstanceInfo) => void;
  /** A sign-in with several accounts: the switch between them. */
  account?: ReactNode;
  /** The organisation whose policy keeps bots off the browsed provider. */
  managedBy?: string | null;
  /** The browsed provider cannot list models yet (setup or sign-in). */
  needsSetup?: { name: string } | null;
  /** The browsed provider lists only its local models until it is signed in. */
  signIn?: { name: string } | null;
  /** Opens the full picker on the browsed provider's setup. */
  onSetUp: () => void;
  /** The rows to show now: suggested, every model, or search results. */
  models: ModelOption[];
  /** Names more than one of the provider's models carry. */
  repeatedLabels?: ReadonlySet<string>;
  /** The search the rows are filtered by, if any. */
  query?: string;
  /** The provider has more models than the suggested rows: one button opens
   * them all in place and folds them back. */
  showAll?: { count: number; open: boolean; onToggle: () => void } | null;
  /** A search box over the opened list, when it is long. */
  search?: ReactNode;
  /** Asks the browsed provider for its models again, when it has none. */
  onRefresh?: (() => void) | null;
  refreshing?: boolean;
  currentModelId?: string;
  onPick: (modelId: string) => void;
  effort?: { levels: EffortLevel[]; current?: EffortLevel; onPick: (level: EffortLevel) => void } | null;
  /** Engines that name their reasoning modes keep their own control. */
  variantsRow?: ReactNode;
  onManage: () => void;
}) {
  const row = "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
  const note = "px-2 py-1.5 text-[12.5px] text-ink-secondary";
  return (
    <div data-simple-model-pane className="flex min-h-0 w-full flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Providers: every one the picker knows, in a quiet column. */}
        <div
          data-simple-providers
          role="group"
          aria-label={t("model.simple.provider")}
          className="flex w-32 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-hairline/40 bg-panel p-1.5"
        >
          {providers.map((provider) => {
            // The same vendor can sit here twice (a sign-in and a pasted
            // key): the key on its mark says which is which, as on the rail.
            const apiKey = provider.target.access === "api";
            const name = providerName(provider);
            const policy = provider.target.policy
              ? t("policy.managedBy", { organization: provider.target.policy.organizationName })
              : undefined;
            const spoken = [name, apiKey ? t("model.simple.apiKey") : undefined, policy].filter(Boolean).join(" · ");
            return (
              <button
                key={provider.instance.instanceId}
                type="button"
                data-simple-provider={provider.instance.instanceId}
                aria-pressed={provider.selected}
                aria-label={spoken === name ? undefined : spoken}
                title={[name, policy ?? (apiKey ? t("model.apiKeyHint") : undefined)].filter(Boolean).join(" · ")}
                onClick={() => onProvider(provider.target)}
                className={cn(
                  row,
                  "font-medium",
                  provider.selected ? "bg-raised-hover text-accent-text" : "text-ink hover:bg-control/60",
                  policy && "opacity-40",
                )}
              >
                <span className="relative flex shrink-0">
                  <InstanceProviderMark instance={provider.target} size={16} />
                  {apiKey && (
                    <span data-simple-key className="absolute -bottom-1 -right-1 flex size-3 items-center justify-center rounded-full bg-panel text-ink-secondary">
                      <KeyRound size={8} aria-hidden="true" />
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">{name}</span>
              </button>
            );
          })}
        </div>

        {/* Models for the chosen provider, or what it needs first. */}
        <div data-simple-models className="flex min-h-0 min-w-0 flex-1 flex-col">
          {account && <div data-simple-account className="shrink-0 px-2">{account}</div>}
          {search && <div data-simple-model-search className="shrink-0 pt-2">{search}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {providers.length === 0 ? (
              <p className={note}>{t("model.noProviders")}</p>
            ) : managedBy ? (
              // The organisation does not allow this provider: shown, never pickable.
              <div data-simple-policy className={cn(note, "leading-relaxed")}>
                <p className="font-medium text-ink">{t("policy.managedBy", { organization: managedBy })}</p>
                <p className="mt-1">{t("policy.modelBlocked", { organization: managedBy })}</p>
              </div>
            ) : needsSetup ? (
              <div className="flex flex-col items-start gap-3 px-2 py-1.5 text-[12.5px] text-ink-secondary">
                <span>{t("model.simple.needsSetup", { name: needsSetup.name })}</span>
                <button type="button" data-simple-set-up onClick={onSetUp} className="rounded-full bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  {t("model.simple.setUp")}
                </button>
              </div>
            ) : models.length === 0 ? (
              query ? (
                <p className={note}>{t("model.noMatch", { query: query.trim() })}</p>
              ) : (
                <div className="flex flex-col items-start gap-1.5 px-2 py-1.5 text-[12.5px] text-ink-secondary">
                  <span>{t("model.simple.noModels")}</span>
                  {onRefresh && (
                    <button
                      type="button"
                      data-simple-refresh
                      disabled={refreshing}
                      onClick={onRefresh}
                      className="-mx-1.5 flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[12px] font-medium text-accent-text hover:bg-control/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-wait disabled:opacity-60"
                    >
                      {refreshing && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                      {t("common.checkAgain")}
                    </button>
                  )}
                </div>
              )
            ) : (
              <>
                <div className="flex flex-col gap-0.5" role="group" aria-label={t("model.simple.model")}>
                  {models.map((option) => {
                    const current = option.id === currentModelId;
                    // Names only; a blurb is a hover hint, never a second
                    // line. A name the list repeats shows its route too, and
                    // the hint and spoken name always carry it.
                    const blurb = modelBlurb(option);
                    const route = option.provider && repeatedLabels?.has(option.label) ? option.provider : undefined;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={current}
                        aria-label={option.provider ? `${option.label} · ${option.provider}` : undefined}
                        title={[option.label, option.provider, blurb].filter(Boolean).join(" · ")}
                        onClick={() => onPick(option.id)}
                        className={cn(row, "font-medium text-ink", current ? "bg-raised-hover" : "hover:bg-control/60")}
                      >
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        {route && (
                          <span data-simple-route className="max-w-[45%] shrink-0 truncate text-[11.5px] font-normal text-ink-secondary">{route}</span>
                        )}
                        {current && <Check size={14} className="shrink-0 text-accent-text" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
                {showAll && (
                  <button
                    type="button"
                    data-simple-show-all
                    aria-expanded={showAll.open}
                    onClick={showAll.onToggle}
                    className={cn(row, "mt-0.5 text-[12px] text-ink-secondary hover:bg-control/60 hover:text-ink")}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {showAll.open ? t("model.showSuggested") : t("model.showAll", { count: showAll.count })}
                    </span>
                    <ChevronDown size={13} className={cn("shrink-0", showAll.open && "rotate-180")} aria-hidden="true" />
                  </button>
                )}
                {signIn && (
                  <button
                    type="button"
                    data-simple-sign-in
                    onClick={onSetUp}
                    className={cn(row, "mt-0.5 text-[12px] font-medium text-accent-text hover:bg-control/60")}
                  >
                    <span className="min-w-0 flex-1 truncate">{t("model.simple.signInForOwn", { name: signIn.name })}</span>
                    <ChevronRight size={13} className="shrink-0" aria-hidden="true" />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Effort and scope along the bottom, spanning both columns. */}
      <div data-simple-effort-band className="flex shrink-0 flex-col gap-2.5 border-t border-hairline/40 px-3 py-2.5">
        {variantsRow ?? (effort && effort.levels.length > 0 && (
          <div
            data-simple-effort
            className="grid w-full gap-1 rounded-xl bg-inset p-1"
            style={{ gridTemplateColumns: `repeat(${effort.levels.length}, minmax(0, 1fr))` }}
            role="group"
            aria-label={t("model.simple.effort")}
          >
            {effort.levels.map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={effort.current === level}
                onClick={() => effort.onPick(level)}
                className={cn(
                  "truncate rounded-lg px-1 py-1.5 text-[12.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                  effort.current === level ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                )}
              >
                {friendlyEffort(level)}
              </button>
            ))}
          </div>
        ))}

        <div className="flex items-center justify-end">
          <button
            type="button"
            data-simple-manage
            onClick={onManage}
            className="-mr-1 ml-auto flex shrink-0 items-center gap-0.5 rounded-lg px-1 py-1 text-[12px] font-medium text-accent-text hover:bg-control/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {t("model.simple.manage")}
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
