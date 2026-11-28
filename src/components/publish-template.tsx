import { useSyncExternalStore, type ReactNode } from "react";
import { Download, FolderDown, Github, Globe, Library, Upload } from "lucide-react";

import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { ShareTemplateDialog } from "./lazy-screens";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";
import { useRepoPublishOffered, useTeamTemplatesOwner } from "./TemplateCard";

export type PublishAction = "community" | "repo" | "team" | "save" | "download";
interface PublishRequest { botId: string; name: string; action: PublishAction }

export const PUBLISH_ITEM = "publish";

let request: PublishRequest | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function openPublish(next: PublishRequest): void {
  request = next;
  changed();
}

function closePublish(): void {
  request = null;
  changed();
}

export interface PublishChoice { key: PublishAction; label: string; icon: ReactNode; onSelect: () => void }

/** A bot's Publish choices here, in order: each makes its template at once and runs on it, no chat message. None for
 * a bot this person may only look at, who can't ask it to share itself either. */
export function usePublishChoices(): (bot: Pick<Bot, "id" | "name" | "yourAccess">) => PublishChoice[] {
  const team = useTeamTemplatesOwner();
  const repo = useRepoPublishOffered();
  return (bot) => {
    if (bot.yourAccess === "view") return [];
    const desktop = Boolean(window.ogb?.pickFolder) && window.ogb?.remoteClient?.active !== true;
    const choices: Array<Omit<PublishChoice, "onSelect">> = [
      { key: "community", label: t("template.publishToCommunity"), icon: <Globe size={16} /> },
      ...(repo ? [{ key: "repo" as const, label: t("template.publishToRepo"), icon: <Github size={16} /> }] : []),
      ...(team ? [{ key: "team" as const, label: t("template.addToTeam", { team }), icon: <Library size={16} /> }] : []),
      ...(desktop ? [{ key: "save" as const, label: t("template.saveFolder"), icon: <FolderDown size={16} /> }] : []),
      { key: "download", label: t("template.download"), icon: <Download size={16} /> },
    ];
    return choices.map((choice) => ({ ...choice, onSelect: () => openPublish({ botId: bot.id, name: bot.name, action: choice.key }) }));
  };
}

/** Publish, with its choices as a submenu; null when there are none. */
export function usePublishItem(bot: Pick<Bot, "id" | "name" | "yourAccess">): SidebarMenuItem | null {
  const choices = usePublishChoices()(bot);
  if (!choices.length) return null;
  return {
    key: PUBLISH_ITEM, label: t("template.publish"), icon: <Upload size={16} />, onSelect: () => {},
    submenu: choices.map((choice) => ({ key: `${PUBLISH_ITEM}:${choice.key}`, label: choice.label, icon: choice.icon, onSelect: choice.onSelect })),
  };
}

/** Where a bot's Publish shows what it did. */
export function PublishTemplateHost() {
  const open = useSyncExternalStore(subscribe, () => request, () => request);
  return open && <ShareTemplateDialog key={`${open.botId}:${open.action}`} target={open} onClose={closePublish} />;
}
