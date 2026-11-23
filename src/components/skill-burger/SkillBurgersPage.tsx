import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";

import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { renameBurger, useSavedBurgers, type SavedWorkflow } from "@/lib/skill-burger";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { BotAvatar } from "../Avatar";
import { SidebarPopoverMenu } from "../SidebarPopoverMenu";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageHeader } from "../ToolPageShell";
import { MiniBurger } from "./MiniBurger";
import { useBurgerRemoval } from "./SavedWorkflowsCard";

function BurgerCard({ skill, onRemove }: { skill: SavedWorkflow; onRemove: () => void }) {
  const advanced = useAdvancedMode();
  const bot = useStoreSelector((state) => (skill.botId ? state.bots.find((candidate) => candidate.id === skill.botId) : undefined));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming !== null) field.current?.select(); }, [renaming !== null]);
  const rename = async () => {
    const to = renaming?.trim().replace(/^-+|-+$/g, "");
    setRenaming(null);
    if (!to || to === skill.name) return;
    setProblem("");
    try {
      await renameBurger(skill, to);
    } catch (cause) {
      setProblem(cause instanceof Error && cause.message ? cause.message : t("skillBurger.renameFailed"));
    }
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); void rename(); }
    if (event.key === "Escape") { event.preventDefault(); setRenaming(null); }
  };
  return (
    <li data-skill-burger-card={skill.name} data-every-chat={skill.everyChat ? "on" : "off"} className="flex min-w-0 gap-3.5 rounded-2xl border border-hairline/40 bg-card p-3.5">
      <MiniBurger skill={skill} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 items-start gap-1">
          <div className="min-w-0 flex-1">
            <h2 dir="auto" className="line-clamp-2 text-[14px] font-semibold leading-[19px] text-ink" title={skill.summary}>{skill.summary}</h2>
            {renaming !== null ? (
              <input
                ref={field}
                dir="ltr"
                value={renaming}
                maxLength={64}
                aria-label={t("skillBurger.editName")}
                onChange={(event) => setRenaming(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                onKeyDown={keys}
                onBlur={() => void rename()}
                className="mt-1 w-full rounded-md border border-hairline/60 bg-app px-1.5 py-0.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
              />
            ) : (
              advanced ? <p className="mt-0.5 truncate font-mono text-[12px] text-ink-tertiary">{skill.name}</p> : null
            )}
          </div>
          <SidebarPopoverMenu
            ariaLabel={t("skillBurger.menu.aria", { name: skill.name })}
            placement="below"
            align="end"
            triggerClassName="shrink-0"
            triggerLabel={t("skillBurger.menu.aria", { name: skill.name })}
            renderTrigger={() => (
              <span className="ui-icon-button flex size-7 items-center justify-center text-ink-secondary hover:bg-raised hover:text-ink" title={t("skillBurger.menu.aria", { name: skill.name })}>
                <MoreHorizontal size={16} aria-hidden="true" />
              </span>
            )}
            items={[
              ...(advanced ? [{ key: "rename", label: t("skillBurger.menu.rename"), icon: <Pencil size={16} />, onSelect: () => setRenaming(skill.name) }] : []),
              { key: "delete", label: t("common.delete"), icon: <Trash2 size={16} />, onSelect: onRemove },
            ]}
          />
        </div>
        <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-secondary">
          {skill.everyChat || !bot ? <span>{t("skillBurger.card.everyChat")}</span> : (
            <>
              <BotAvatar bot={bot} size={16} />
              <span dir="auto" className="min-w-0 truncate">{bot.name}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{skill.layers.length === 1 ? t("skillBurger.layersOne") : t("skillBurger.layersMany", { count: skill.layers.length })}</span>
        </p>
        {problem && <p role="alert" className="text-[12px] text-danger">{problem}</p>}
      </div>
    </li>
  );
}

/** Every Skill Burger the person's bots made: each bot's own, and the ones used in every chat. */
export function SkillBurgersPage() {
  const dispatch = useStoreDispatch();
  const { skills, error, refresh } = useSavedBurgers();
  const { removed, problem, remove, undo } = useBurgerRemoval();
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);

  return (
    <ToolPage label={t("skillBurger.list.title")}>
      <ToolPageHeader backLabel={t("automations.back")} onBack={() => dispatch({ type: "showChat" })} backRef={back}>
        <h1 className={TOOL_PAGE_TITLE}>{t("skillBurger.list.title")}</h1>
      </ToolPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-skill-burgers={skills ? skills.length : "loading"}>
        <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
          {removed && (
            <div role="status" className="mb-3 flex items-center gap-2 rounded-xl bg-card px-3.5 py-2.5 text-[13px] text-ink-secondary">
              <span className="min-w-0 flex-1 truncate">{t("skillBurger.list.removed", { name: removed.skill.name })}</span>
              <button type="button" onClick={() => void undo()} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-accent-text hover:bg-ink/[0.06]">{t("common.undo")}</button>
            </div>
          )}
          {problem && <p role="alert" className="mb-3 text-[13px] text-danger">{problem}</p>}
          {error && !skills ? (
            <section role="alert" className="px-6 py-16 text-center">
              <p className="text-[14px] text-ink-secondary">{t("skillBurger.list.loadFailed")}</p>
              <button type="button" className="ui-button mt-4" onClick={refresh}>{t("common.tryAgain")}</button>
            </section>
          ) : skills && skills.length === 0 ? (
            <section aria-label={t("skillBurger.page.empty")} className="flex flex-col items-center px-6 py-16 text-center">
              <MiniBurger skill={{ layers: [{ kind: "app", app: "googlesheets", label: "" }, { kind: "ai", label: "" }, { kind: "app", app: "gmail", label: "" }] }} />
              <h2 className="mt-4 text-[17px] font-semibold text-ink">{t("skillBurger.page.empty")}</h2>
              <p className="mx-auto mt-2 max-w-sm text-[14px] leading-relaxed text-ink-secondary">{t("skillBurger.list.empty")}</p>
            </section>
          ) : skills ? (
            <ul aria-label={t("skillBurger.list.title")} className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-4">
              {skills.map((skill) => <BurgerCard key={`${skill.everyChat ? "every" : skill.botId}:${skill.name}`} skill={skill} onRemove={() => void remove(skill)} />)}
            </ul>
          ) : null}
        </div>
      </div>
    </ToolPage>
  );
}
