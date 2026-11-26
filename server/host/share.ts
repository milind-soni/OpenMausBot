// Templates' wiring: the share host, its HTTP routes and the share tool's internal route, from index.ts's records.
import { userInfo } from "node:os";

import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar.ts";
import type { TemplateCard } from "../../shared/share-card.ts";
import type { WireBot, WireGroup } from "../../shared/wire.ts";
import { readAttachment } from "../attachments.ts";
import { teamCreator } from "../new-bot-sharing.ts";
import type { PackageImportDeps } from "../package-import.ts";
import type { PagesAccess } from "../pages/access.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Routine } from "../routines.ts";
import { createShareRoutes, createShareToolRoute } from "../routes/share.ts";
import { createShareHost, type ShareHostDeps } from "../share.ts";
import { createCommunityPublisher } from "../share-publish.ts";
import type { BotRecord, GroupRecord } from "../store.ts";
import { createTeamTemplates } from "../team-templates.ts";
import { createShareGithubAccess, type ShareGithubAccessDeps } from "./share-github-access.ts";

export interface ShareWiringDeps extends Pick<ShareHostDeps, "dataDir" | "groups" | "brief" | "botFolder" | "collectTeamSkills" | "skillFiles"> {
  bots(): readonly BotRecord[];
  routines(): readonly Routine[];
  access(): PagesAccess | null;
  notOffered(): boolean;
  selfHosted: boolean;
  localFolders: boolean;
  visibleBot?(auth: RequestAuth): (botId: string) => boolean;
  visibleRoutine?(auth: RequestAuth): (routine: Routine) => boolean;
  patchMessage(threadId: string, messageId: string, patch: { text: string; template: TemplateCard }): void;
  importDeps(): Promise<PackageImportDeps>;
  publicBot(bot: BotRecord): WireBot;
  publicGroup(group: GroupRecord): WireGroup;
  broadcast(payload: Record<string, unknown>): void;
  /** A Team Cloud's team: it gets a library of its own templates. */
  team: { name: string } | null;
  /** A request's person on a Team Cloud, and how the team's library names them. */
  personOf(auth: RequestAuth): string | null;
  who(auth: RequestAuth): string | undefined;
  github: ShareGithubAccessDeps;
}

/** A bot's own picture as a data: URL; none for a mascot. */
function botPicture(bot: BotRecord): string | undefined {
  if (!bot.avatarUrl || bot.avatarCrop === "mascot") return undefined;
  const name = bot.avatarUrl.split("/").pop() ?? "";
  if (botAvatarUrlFromStoredPath(name) !== bot.avatarUrl) return undefined;
  const stored = readAttachment(name);
  return stored ? `data:${stored.mime};base64,${stored.bytes.toString("base64")}` : undefined;
}

/** This computer's user name; none where the system has no entry for the process's user. */
function systemUserName(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

export function createShareWiring(deps: ShareWiringDeps) {
  // A Team Cloud's profile is nobody's own, so it neither names the publisher nor is taken out for them.
  const profileName = () => (deps.team ? undefined : deps.github.cfg().profile?.name?.trim() || undefined);
  const host = createShareHost({
    dataDir: deps.dataDir, bots: deps.bots, groups: deps.groups, routines: deps.routines, brief: deps.brief, botFolder: deps.botFolder,
    collectTeamSkills: deps.collectTeamSkills, skillFiles: deps.skillFiles, picture: botPicture,
    publisher: createCommunityPublisher({ access: deps.access, notOffered: deps.notOffered, selfHosted: deps.selfHosted }),
    personNames: () => [systemUserName(), profileName()], suggestedCredit: profileName,
    patch: (threadId, messageId, text, template) => deps.patchMessage(threadId, messageId, { text, template }),
  });
  const view = { publicBot: deps.publicBot, publicGroup: deps.publicGroup, broadcast: deps.broadcast };
  const library = deps.team ? { team: deps.team.name, templates: createTeamTemplates(deps.dataDir) } : null;
  const github = createShareGithubAccess(deps.github);
  const routes = createShareRoutes({
    host, localFolders: deps.localFolders, ...view, library, github, personOf: deps.personOf, who: deps.who,
    bots: (auth) => { const shown = deps.visibleBot?.(auth); return shown ? deps.bots().filter((bot) => shown(bot.id)) : deps.bots(); },
    routines: (auth) => { const shown = deps.visibleRoutine?.(auth); return shown ? deps.routines().filter(shown) : deps.routines(); },
    importDeps: async (auth) => ({ ...await deps.importDeps(), ...(auth ? teamCreator(auth) : {}) }),
  });
  const tool = createShareToolRoute({ host, localFolders: deps.localFolders, ...view, library, github, bots: deps.bots, routines: deps.routines, importDeps: () => deps.importDeps() });
  return { host, routes, tool };
}
