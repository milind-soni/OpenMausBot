// Security: a chosen file is read in the browser and posted as text, exactly like a paste. Nothing here fetches a URL.
export const SKILL_FILE_ACCEPT = ".md,.markdown,text/markdown,text/plain";

/** The chosen files that may hold a SKILL.md; an image or an archive from the same picker is left alone. */
export function skillFilesOf(list: FileList | readonly File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter((file) => /\.(?:md|markdown|txt)$/i.test(file.name) || /^text\/(?:markdown|plain)$/i.test(file.type));
}
