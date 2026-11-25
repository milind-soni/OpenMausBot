import type { TeamTemplate, TemplateCard, TemplateDetails, TemplateRepoPublish } from "../../shared/share-card";
import { SKILL_FILE_LIMITS, skillFilePathProblem } from "../../shared/skill-files";
import { t } from "./i18n";
import { api, type Action, type Bot, type Group } from "@/state/store";
import type { Routine } from "@/lib/routines";
import { serverFetch } from "./relay-server";

/** The most a chosen folder may hold, as the server's own folder cap. */
export const TEMPLATE_FOLDER_MAX_BYTES = 4 * 1024 * 1024;
const PICTURE = /\.(png|jpe?g|webp)$/i;
const TEXT = /\.(md|json|txt)$/i;
const SKILL_FILE = /(?:^|\/)skills\/[a-z0-9][a-z0-9-]{0,63}\/(.+)$/;

/** A file beside a skill's SKILL.md that may travel with it, judged by its path and size before it is read. */
function skillFileOf(file: File): boolean {
  const inner = ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).match(SKILL_FILE)?.[1];
  return inner !== undefined && inner !== "SKILL.md" && skillFilePathProblem(inner) === null && file.size <= SKILL_FILE_LIMITS.fileBytes;
}

export interface ImportedTemplate {
  name: string;
  section: string;
  bots: Bot[];
  groups?: Group[];
  routines?: Routine[];
  appsToConnect?: number;
}

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

export const exportDepartment = (department: string) => api<TemplateCard>("/api/share/export", post({ department }));
export const templateDetails = (id: string) => api<{ card: TemplateCard; details: TemplateDetails }>(`/api/share/${encodeURIComponent(id)}`);
export const publishTemplate = (id: string) => api<TemplateCard>(`/api/share/${encodeURIComponent(id)}/publish`, post({}));
export const deleteTemplate = (id: string) => api<{ ok: true }>(`/api/share/${encodeURIComponent(id)}`, { method: "DELETE" });

export type ImportSource = { url: string } | { path: string } | { files: Record<string, string> } | { library: string };

/** A Team Cloud's own templates, for its owner and admins. */
export const teamTemplates = () => api<{ team: string; templates: TeamTemplate[] }>("/api/share/library");
export const addToTeamTemplates = (id: string) =>
  api<{ template: TeamTemplate; replaced: boolean }>(`/api/share/${encodeURIComponent(id)}/library`, post({}));
export const removeTeamTemplate = (slug: string) => api<{ ok: true }>(`/api/share/library/${encodeURIComponent(slug)}`, { method: "DELETE" });

/** Whether a GitHub connection is there to publish to the person's own repository through. */
export const githubConnection = () => api<{ connected: boolean; reason?: "not_connected" | "refused" | "unavailable"; error?: string }>("/api/share/github");
export const publishToRepo = (id: string, target: { repo: string; folder?: string; direct?: boolean }) =>
  api<TemplateRepoPublish>(`/api/share/${encodeURIComponent(id)}/publish-repo`, post(target));

export const previewImport = (source: ImportSource) =>
  api<{ details: TemplateDetails }>("/api/share/import?preview=1", post(source)).then((answer) => answer.details);

/** Adds the template as new bots alongside everything here and selects the first one. */
export async function addImport(source: ImportSource, dispatch: (action: Action) => void): Promise<ImportedTemplate> {
  const added = await api<ImportedTemplate>("/api/share/import", post(source));
  for (const bot of added.bots) dispatch({ type: "botAdded", bot });
  for (const group of added.groups ?? []) dispatch({ type: "groupPatched", group });
  for (const routine of added.routines ?? []) dispatch({ type: "routinePatched", routine });
  const first = added.bots.find((bot) => !bot.hidden);
  if (first) dispatch({ type: "select", id: first.id });
  return added;
}

export function addedLine(added: Pick<ImportedTemplate, "appsToConnect">): string {
  const apps = added.appsToConnect ?? 0;
  return apps === 0 ? t("templateImport.added") : apps === 1 ? t("templateImport.addedAppOne") : t("templateImport.addedAppMany", { count: apps });
}

/** "2 bots · 3 skills · 2 routines (paused) · 1 app", leaving out what the template has none of (bots only for a department). */
export function countsLine(card: Pick<TemplateCard, "scope" | "counts">): string {
  const { bots, skills, routines, apps } = card.counts;
  return [
    ...(card.scope === "department" ? [bots === 1 ? t("template.botsOne") : t("template.botsMany", { count: bots })] : []),
    ...(skills ? [skills === 1 ? t("template.skillsOne") : t("template.skillsMany", { count: skills })] : []),
    ...(routines ? [routines === 1 ? t("template.routinesOne") : t("template.routinesMany", { count: routines })] : []),
    ...(apps ? [apps === 1 ? t("template.appsOne") : t("template.appsMany", { count: apps })] : []),
  ].join(" · ");
}

/** Puts the template's folder on this device: a folder the person picks on the desktop app, a .zip download elsewhere.
 * The folder's path when it was written, null when cancelled or downloaded. */
export async function saveTemplateFolder(card: Pick<TemplateCard, "id" | "name">): Promise<string | null> {
  const pick = window.ogb?.remoteClient?.active ? undefined : window.ogb?.pickFolder;
  if (pick) {
    const chosen = await pick();
    if (!chosen) return null;
    return (await api<{ path: string }>(`/api/share/${encodeURIComponent(card.id)}/save`, post({ path: chosen }))).path;
  }
  const response = await serverFetch(`/api/share/${encodeURIComponent(card.id)}/download`);
  if (!response.ok) throw new Error(t("template.failed"));
  const url = URL.createObjectURL(new Blob([await response.blob()], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${card.name.replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || "template"}.zip`;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return null;
}

const readText = (file: File) => file.text();
const readDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error(t("templateImport.folderUnreadable")));
  reader.readAsDataURL(file);
});

/** A folder chosen in a browser, as the import route takes it: Markdown, JSON and the files beside a skill as text,
 * pictures as data: URLs, and nothing else. Refuses a folder over the size cap before reading it. */
export async function folderFiles(files: ArrayLike<File>): Promise<Record<string, string>> {
  const kept = Array.from(files).filter((file) => TEXT.test(file.name) || PICTURE.test(file.name) || skillFileOf(file));
  if (kept.reduce((total, file) => total + file.size, 0) > TEMPLATE_FOLDER_MAX_BYTES) throw new Error(t("templateImport.tooLarge"));
  const out: Record<string, string> = {};
  for (const file of kept) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    out[path] = PICTURE.test(file.name) && !skillFileOf(file) ? await readDataUrl(file) : await readText(file);
  }
  return out;
}

/** Sends `text` as the person's own message in this bot's conversation, visible and editable like any other. */
export function askBot(dispatch: (action: Action) => void, botId: string, threadId: string | undefined, text: string): void {
  dispatch({ type: "select", id: botId });
  dispatch({ type: "send", botId, text, ...(threadId ? { threadId } : {}) });
}
