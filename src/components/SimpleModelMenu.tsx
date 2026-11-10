import { useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, ChevronUp, Download, Lightbulb, Loader2, LogIn, RefreshCw, Search, Settings, Star, X } from "lucide-react";
import type { Bot, InstanceInfo } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import type { MenuGroup, MenuModelRow, SimpleMenu } from "@/lib/simple-model-menu";
import { favoriteKey, toggleFavoriteModel, useFavoriteModels } from "@/lib/favorite-models";
import { modelOptionLabel } from "@/lib/model-label";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BotAvatar } from "./Avatar";
import { InstanceProviderMark } from "./ProviderIcons";
import { MENU_GUTTER, MENU_ICON, MENU_LABEL, MENU_LINE, MENU_NOTE, MENU_ROW, MENU_SEPARATOR, MENU_STROKE, MENU_TRAILING, SIMPLE_MENU_META, SIMPLE_MENU_ROW } from "./menu-recipe";
import { effortLabel } from "./ModelPicker";

export type SimpleThinking =
  | { levels: readonly EffortLevel[]; current?: EffortLevel; onPick: (level: EffortLevel) => void; onReset: () => void }
  | { variants: ReactNode };

export interface SimpleMenuActions {
  onQuery: (query: string) => void;
  onPick: (instance: InstanceInfo, model: string, variant?: string) => void;
  onPickCurrent: () => void;
  onFollowBot: () => void;
  onToggle: (instance: InstanceInfo) => void;
  onSetUp: (instance: InstanceInfo, keyboard: boolean) => void;
  onCheckAgain: (instance: InstanceInfo) => void;
  /** Opens the provider settings; left out where they live on another computer. */
  onManage?: () => void;
  onResetVariant?: () => void;
}

export interface SimpleModelMenuProps extends SimpleMenuActions {
  menu: SimpleMenu;
  query: string;
  bot: Pick<Bot, "name" | "color" | "avatarUrl" | "avatarCrop" | "avatarZoom" | "avatarFocusX" | "avatarFocusY" | "mascotBody">;
  botModel: { label: string; title: string };
  thinking?: SimpleThinking | null;
  idPrefix: string;
}

const Gutter = ({ children }: { children?: ReactNode }) => <span className={MENU_GUTTER}>{children}</span>;
const Forward = () => <ChevronRight size={16} strokeWidth={MENU_STROKE} className={MENU_TRAILING} aria-hidden="true" />;

/** A model's name and its secondary label, each on its own line so a long name never eats the label beside it. */
function RowLines({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <span data-simple-model-text className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{label}</span>
      {children}
    </span>
  );
}

/** Stays where it is when pressed: the row moves up the next time the menu opens, not under the pointer. */
export function FavoriteStar({ instanceId, model, name }: { instanceId: string; model: string; name: string }) {
  const favorite = useFavoriteModels().has(favoriteKey(instanceId, model));
  return (
    <button
      type="button"
      data-model-favorite
      tabIndex={-1}
      aria-pressed={favorite}
      aria-label={t(favorite ? "model.favorite.remove" : "model.favorite.add", { name })}
      title={t(favorite ? "model.favorite.remove" : "model.favorite.add", { name })}
      onClick={() => toggleFavoriteModel(instanceId, model)}
      className={cn("absolute end-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-tertiary hover:text-ink",
        favorite ? "opacity-100" : "opacity-0 group-hover/model:opacity-100 touch:opacity-100")}
    >
      <Star size={13} aria-hidden="true" className={cn(favorite && "fill-current")} />
    </button>
  );
}

function MenuModel({ instance, row, onPick }: { instance: InstanceInfo; row: MenuModelRow; onPick: SimpleMenuActions["onPick"] }) {
  const { option } = row;
  const reason = row.blocked ? t("model.orgBlocked") : undefined;
  return (
    <div className="group/model relative">
    <button
      type="button"
      data-menu-row
      data-org-blocked={row.blocked || undefined}
      disabled={row.blocked}
      aria-pressed={row.current}
      aria-label={[modelOptionLabel(option), option.provider, row.detail, reason].filter(Boolean).join(" · ")}
      title={[modelOptionLabel(option), option.provider, row.detail, reason].filter(Boolean).join(" · ")}
      tabIndex={-1}
      onClick={() => onPick(instance, row.model ?? option.id, row.variant)}
      className={cn(SIMPLE_MENU_ROW, "pe-8")}
    >
      <Gutter />
      <RowLines label={row.label}>
        {row.route && <span data-simple-route className={SIMPLE_MENU_META}>{row.route}</span>}
        {row.detail && <span data-simple-model-detail className={SIMPLE_MENU_META}>{row.detail}</span>}
        {reason && <span data-simple-org-blocked className={SIMPLE_MENU_META}>{reason}</span>}
      </RowLines>
      {row.current && <Check size={14} className="shrink-0 text-ink" aria-hidden="true" />}
    </button>
    {!row.blocked && <FavoriteStar instanceId={instance.instanceId} model={option.id} name={modelOptionLabel(option)} />}
    </div>
  );
}

function GroupBody({ group, props }: { group: MenuGroup; props: SimpleModelMenuProps }) {
  const { instance, body } = group;
  switch (body.kind) {
    case "policy":
      return (
        <div data-simple-policy className="flex flex-col gap-0.5 py-1 pl-8 pr-2">
          <p className="text-[13px] leading-[18px] text-ink-secondary">{t("policy.managedBy", { organization: body.organization })}</p>
          <p className="text-[12px] leading-4 text-ink-tertiary">{t(body.team ? "policy.teamModelBlocked" : "policy.modelBlocked", { organization: body.organization })}</p>
        </div>
      );
    case "setUp":
    case "signIn":
      return (
        <button type="button" data-menu-row data-simple-set-up tabIndex={-1} onClick={(event) => props.onSetUp(instance, event.detail === 0)}
          title={t("model.simple.needsSetup", { name: group.account ?? group.provider })} className={MENU_ROW}>
          <Gutter>{body.kind === "setUp" ? <Download size={16} strokeWidth={MENU_STROKE} className={MENU_ICON} aria-hidden="true" /> : <LogIn size={16} strokeWidth={MENU_STROKE} className={MENU_ICON} aria-hidden="true" />}</Gutter>
          <span className="min-w-0 flex-1 truncate">{body.kind === "setUp" ? t("model.simple.setUp") : t("model.simple.signIn")}</span>
          <Forward />
        </button>
      );
    case "empty":
      return body.loading ? (
        <div role="status" className={cn(MENU_LINE, "text-ink-tertiary")}>
          <Gutter><Loader2 size={14} className="animate-spin" aria-hidden="true" /></Gutter>
          <span className="min-w-0 flex-1 truncate">{t("model.loadingModels", { name: group.provider })}</span>
        </div>
      ) : (
        <>
          <p className={cn(MENU_NOTE, "pl-8")}>{t("model.simple.noModels")}</p>
          <button type="button" data-menu-row data-simple-refresh tabIndex={-1} disabled={props.menu.busy} onClick={() => props.onCheckAgain(instance)} className={MENU_ROW}>
            <Gutter>
              {props.menu.busy
                ? <Loader2 size={14} className="animate-spin text-ink-secondary" aria-hidden="true" />
                : <RefreshCw size={16} strokeWidth={MENU_STROKE} className={MENU_ICON} aria-hidden="true" />}
            </Gutter>
            <span className="min-w-0 flex-1 truncate">{t("common.checkAgain")}</span>
          </button>
        </>
      );
    case "models":
      return (
        <>
          {body.rows.map((row, index) => (
            <div key={row.option.id} className="contents">
              {index === body.localFrom && <div className={cn(MENU_LABEL, "pl-8 font-normal")}>{t("model.localModels")}</div>}
              <MenuModel instance={instance} row={row} onPick={props.onPick} />
            </div>
          ))}
          {body.probing && (
            <div role="status" className={cn(MENU_LINE, "text-ink-tertiary")}>
              <Gutter><Loader2 size={14} className="animate-spin" aria-hidden="true" /></Gutter>
              <span className="min-w-0 flex-1 truncate">{t("model.lookingLocal")}</span>
            </div>
          )}
          {body.signInForOwn && (
            <button type="button" data-menu-row data-simple-sign-in tabIndex={-1} onClick={(event) => props.onSetUp(instance, event.detail === 0)} className={MENU_ROW}>
              <Gutter><LogIn size={16} strokeWidth={MENU_STROKE} className={MENU_ICON} aria-hidden="true" /></Gutter>
              <span className="min-w-0 flex-1 truncate">{t("model.simple.signInForOwn", { name: group.provider })}</span>
              <Forward />
            </button>
          )}
          {body.toggle && (
            <div className={cn(body.toggle === "less" && "sticky bottom-0 z-[1] -mx-1.5 bg-linear-to-b from-transparent to-menu to-[12px] px-1.5 pt-3")}>
              <button type="button" data-menu-row data-simple-show-all tabIndex={-1} aria-expanded={body.toggle === "less"}
                onClick={() => props.onToggle(instance)} className={cn(MENU_ROW, "text-ink-secondary hover:text-ink focus:text-ink")}>
                <Gutter />
                <span className="min-w-0 flex-1 truncate">{body.toggle === "less" ? t("model.showSuggested") : t("model.showAll", { count: body.total })}</span>
                {body.toggle === "less"
                  ? <ChevronUp size={16} strokeWidth={MENU_STROKE} className={MENU_TRAILING} aria-hidden="true" />
                  : <ChevronDown size={16} strokeWidth={MENU_STROKE} className={MENU_TRAILING} aria-hidden="true" />}
              </button>
            </div>
          )}
        </>
      );
  }
}

/** Thinking folds to one row that names the level; the steps open under it, so most people only ever read "Auto". */
function Thinking({ thinking, labelId }: { thinking: SimpleThinking; labelId: string }) {
  const [open, setOpen] = useState(false);
  if ("variants" in thinking) return <div data-simple-thinking>{thinking.variants}</div>;
  const levels = thinking;
  const auto = levels.current === undefined;
  const pill = (pressed: boolean) => cn(
    "h-8 min-w-0 truncate rounded-full px-1.5 text-[13px] leading-4 transition-colors",
    pressed ? "bg-ink/[0.1] font-medium text-ink" : "text-ink-secondary hover:text-ink",
  );
  return (
    <div data-simple-thinking className="flex flex-col">
      <button type="button" data-menu-row data-simple-thinking-toggle tabIndex={-1} aria-expanded={open} aria-controls={`${labelId}-steps`}
        onClick={() => setOpen(!open)} className={cn(MENU_ROW, open && "hover:bg-transparent focus:bg-transparent")}>
        <Gutter><Lightbulb size={16} strokeWidth={MENU_STROKE} className={MENU_ICON} aria-hidden="true" /></Gutter>
        <span id={labelId} className="min-w-0 flex-1 truncate">{t("botSettings.simple.thinking")}</span>
        {!open && <span className="shrink-0 text-ink-secondary">{auto ? t("model.simple.auto") : effortLabel(levels.current!)}</span>}
        {open
          ? <ChevronUp size={16} strokeWidth={MENU_STROKE} className={MENU_TRAILING} aria-hidden="true" />
          : <ChevronDown size={16} strokeWidth={MENU_STROKE} className={MENU_TRAILING} aria-hidden="true" />}
      </button>
      <div id={`${labelId}-steps`} hidden={!open}>
        <div data-simple-effort role="group" aria-labelledby={labelId} className="m-1 grid rounded-full bg-ink/[0.05] p-[3px]"
          style={{ gridTemplateColumns: `repeat(${levels.levels.length + 1}, auto)` }}>
          <button type="button" data-effort-pill data-effort-auto aria-pressed={auto} tabIndex={auto ? 0 : -1}
            title={t("model.simple.thinkingDefault")} onClick={levels.onReset} className={pill(auto)}>
            {t("model.simple.auto")}
          </button>
          {levels.levels.map((level) => (
            <button
              key={level}
              type="button"
              data-effort-pill
              aria-pressed={levels.current === level}
              tabIndex={levels.current === level ? 0 : -1}
              title={t("model.simple.thinkingLevel", { level: effortLabel(level) })}
              onClick={() => levels.onPick(level)}
              className={pill(levels.current === level)}
            >
              {effortLabel(level)}
            </button>
          ))}
        </div>
        <p data-simple-effort-auto={auto || undefined} className="px-2 pb-1 text-[12px] leading-4 text-ink-tertiary">
          {auto ? t("model.simple.thinkingAuto") : t(`model.simple.effortHint.${levels.current!}`)}
        </p>
      </div>
    </div>
  );
}

export function SimpleModelMenu(props: SimpleModelMenuProps) {
  const { menu, query, idPrefix } = props;
  const current = menu.current;
  const top = Boolean(current || menu.follow);
  return (
    <div data-simple-model-menu className="flex min-h-0 flex-1 flex-col">
      {menu.search && (
        <div data-simple-model-search className="group/search flex h-9 shrink-0 items-center gap-2 border-b-[0.5px] border-ink/10 pl-3.5 pr-2">
          <Search size={16} strokeWidth={MENU_STROKE} className="shrink-0 text-ink-tertiary group-focus-within/search:text-ink-secondary" aria-hidden="true" />
          <input
            data-menu-search
            value={query}
            onChange={(event) => props.onQuery(event.target.value)}
            placeholder={t("model.search")}
            aria-label={menu.groups.every((group) => group.instance.access === "custom") ? t("model.searchLocal") : t("model.search")}
            className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-ink outline-none placeholder:text-ink-tertiary"
          />
          {query && (
            <button type="button" aria-label={t("model.simple.clearSearch")} onClick={() => props.onQuery("")}
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink">
              <X size={14} strokeWidth={MENU_STROKE} aria-hidden="true" />
            </button>
          )}
          {menu.results !== null && <span role="status" className="sr-only">{t("model.results", { count: menu.results })}</span>}
        </div>
      )}

      <div data-simple-models className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain",
        menu.groups.some((group) => group.body.kind === "models" && group.body.toggle === "less") && "scroll-pt-8 scroll-pb-12")}>
        <div className="flex flex-col gap-0.5 p-1.5">
          {current && (
            <button
              type="button"
              data-menu-row
              data-current-model
              aria-pressed="true"
              title={current.title}
              onClick={(event) => {
                const setUp = current.warning && current.instance && !current.instance.policy && !current.blocked ? current.instance : undefined;
                if (setUp) props.onSetUp(setUp, event.detail === 0);
                else props.onPickCurrent();
              }}
              className={SIMPLE_MENU_ROW}
            >
              <Gutter>
                {current.instance
                  ? <InstanceProviderMark instance={current.instance} size={14} subtle />
                  : <span className="size-3.5 rounded-full bg-ink/[0.08]" aria-hidden="true" />}
              </Gutter>
              <RowLines label={current.label}>
                {current.meta && <span className={cn(SIMPLE_MENU_META, current.warning && "text-warning")}>{current.meta}</span>}
              </RowLines>
              {current.pending && <Loader2 size={14} className="shrink-0 animate-spin text-ink-tertiary" aria-hidden="true" />}
              <Check size={14} className="shrink-0 text-ink" aria-hidden="true" />
            </button>
          )}
          {menu.follow && (
            <button type="button" data-menu-row data-follow-bot-model aria-pressed="false" tabIndex={-1} title={props.botModel.title}
              onClick={props.onFollowBot} className={SIMPLE_MENU_ROW}>
              <Gutter><BotAvatar bot={props.bot} size={16} state="happy" animated={false} label="" /></Gutter>
              <RowLines label={t("model.useBotModel", { name: props.bot.name })}>
                <span className={SIMPLE_MENU_META}>{props.botModel.label}</span>
              </RowLines>
            </button>
          )}
          {top && menu.groups.length > 0 && <div role="separator" className={MENU_SEPARATOR} />}

          {menu.groups.map((group, index) => {
            const labelId = `${idPrefix}-group-${index}`;
            const expanded = group.body.kind === "models" && group.body.toggle === "less";
            return (
              <div key={group.instance.instanceId} role="group" aria-labelledby={labelId} data-simple-provider={group.instance.instanceId}
                className={cn("flex flex-col gap-0.5", index > 0 && "mt-1")}>
                <div id={labelId} className={cn(MENU_LABEL, expanded && "sticky top-0 z-[1] -mx-1.5 bg-menu px-3.5")}>
                  <Gutter><InstanceProviderMark instance={group.instance} size={14} subtle /></Gutter>
                  <span className="min-w-0 truncate">{group.label}</span>
                </div>
                {group.note && <p className={cn(MENU_NOTE, "pl-8 pt-0")}>{group.note}</p>}
                <GroupBody group={group} props={props} />
              </div>
            );
          })}

          {menu.empty === "loading" && (
            <div role="status" className={cn(MENU_LINE, "text-ink-tertiary")}>
              <Gutter><Loader2 size={14} className="animate-spin" aria-hidden="true" /></Gutter>
              <span className="min-w-0 flex-1 truncate">{t("model.simple.lookingModels")}</span>
            </div>
          )}
          {menu.empty === "none" && <p className={cn(MENU_NOTE, !top && "pt-2")}>{t("model.noProviders")}</p>}
          {menu.results === 0 && <p className={cn(MENU_NOTE, "py-2")}>{t("model.noMatch", { query: menu.query })}</p>}
        </div>
      </div>

      {(props.thinking || props.onResetVariant || props.onManage) && (
        <div data-simple-effort-band className="flex shrink-0 flex-col gap-0.5 p-1.5 pt-0">
          <div role="separator" className={MENU_SEPARATOR} />
          {props.thinking && (
            <>
              <Thinking thinking={props.thinking} labelId={`${idPrefix}-thinking`} />
              {(props.onResetVariant || props.onManage) && <div role="separator" className={MENU_SEPARATOR} />}
            </>
          )}
          {props.onResetVariant && (
            <button type="button" data-menu-row data-simple-variant-default onClick={props.onResetVariant} className={MENU_ROW}>
              <Gutter />
              <span className="min-w-0 flex-1 truncate">{t("model.variant.session")}</span>
            </button>
          )}
          {props.onManage && (
            <button type="button" data-menu-row data-simple-manage onClick={props.onManage} className={MENU_ROW}>
              <Gutter><Settings size={16} strokeWidth={MENU_STROKE} className={MENU_ICON} aria-hidden="true" /></Gutter>
              <span className="min-w-0 flex-1 truncate">{t("model.simple.manage")}</span>
              <Forward />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
